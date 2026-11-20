// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Kyntra.Api.Tests.Infrastructure;
using Kyntra.Persistence.Entities;
using Kyntra.Users.Account;
using Kyntra.Users.Auth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Kyntra.Api.Tests;

/// <summary>
/// Nonces the server issues (ADR 0052, F-19): a sign-in or a deletion re-check is accepted only with a nonce from
/// <c>POST /auth/nonce</c>, once, within its lifetime. Every nonce here comes from the endpoint.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class NonceTests(PostgresFixture postgres) : IDisposable
{
    private const string GoogleSubject = "109876543210987654321";

    private readonly TestClock clock = TestClock.Create();
    private readonly FakeIdentityProvider idp = new();

    public void Dispose() => idp.Dispose();

    [Fact]
    public async Task The_endpoint_issues_a_random_nonce_and_stores_only_its_hash()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();

        var first = await NonceAsync(client);
        var second = await NonceAsync(client);

        Assert.Matches("^[A-Za-z0-9_-]{43}$", first.Nonce);
        Assert.NotEqual(first.Nonce, second.Nonce);
        Assert.Equal(clock.GetUtcNow().Add(SignInNonces.Lifetime), first.ExpiresAt);
        var stored = await host.WithDatabaseAsync(db => db.Set<SignInNonce>().AsNoTracking().ToListAsync());
        Assert.Equal(2, stored.Count);
        Assert.Contains(stored, n => n.Hash.SequenceEqual(SHA256.HashData(Encoding.UTF8.GetBytes(first.Nonce))));
        Assert.DoesNotContain(stored, n => n.Hash.SequenceEqual(Encoding.UTF8.GetBytes(first.Nonce)));
    }

    [Theory]
    [InlineData("apple")]
    [InlineData("google")]
    public async Task An_issued_nonce_signs_in_once_and_a_replay_is_refused(string provider)
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        var nonce = (await NonceAsync(client)).Nonce;
        var token = Token(provider, nonce);

        using var first = await SignInAsync(client, provider, token, nonce);
        using var replay = await SignInAsync(client, provider, token, nonce);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        Assert.Empty(await host.WithDatabaseAsync(db => db.Set<SignInNonce>().AsNoTracking().ToListAsync()));
    }

    [Theory]
    [InlineData("apple")]
    [InlineData("google")]
    public async Task A_nonce_the_server_never_issued_is_refused(string provider)
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        const string MadeByTheApp = "a-nonce-the-app-made-itself";

        using var response = await SignInAsync(client, provider, Token(provider, MadeByTheApp), MadeByTheApp);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Empty(await host.WithDatabaseAsync(db => db.Users.AsNoTracking().ToListAsync()));
    }

    [Fact]
    public async Task An_expired_nonce_is_refused()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        var nonce = (await NonceAsync(client)).Nonce;

        clock.Advance(SignInNonces.Lifetime + TimeSpan.FromSeconds(1));
        using var response = await SignInAsync(client, "google", Token("google", nonce), nonce);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_bad_token_does_not_use_up_the_nonce()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        var nonce = (await NonceAsync(client)).Nonce;

        using var wrongAudience = await SignInAsync(client, "google", idp.Issue(clock, FakeIdentityProvider.GoogleIssuer, "other-client.apps.test", rawNonce: nonce), nonce);
        using var good = await SignInAsync(client, "google", Token("google", nonce), nonce);

        Assert.Equal(HttpStatusCode.Unauthorized, wrongAudience.StatusCode);
        Assert.Equal(HttpStatusCode.OK, good.StatusCode);
    }

    [Fact]
    public async Task Simultaneous_requests_with_one_nonce_sign_in_once()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        var nonce = (await NonceAsync(client)).Nonce;
        var token = Token("google", nonce);

        var responses = await Task.WhenAll(Enumerable.Range(0, 6).Select(async _ =>
        {
            using var racer = host.CreateClient();
            using var response = await SignInAsync(racer, "google", token, nonce);
            return response.StatusCode;
        }));

        Assert.Single(responses, status => status == HttpStatusCode.OK);
        Assert.All(responses.Where(status => status != HttpStatusCode.OK), status => Assert.Equal(HttpStatusCode.Unauthorized, status));
    }

    [Fact]
    public async Task A_sign_in_token_cannot_be_replayed_to_delete_the_account()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        var nonce = (await NonceAsync(client)).Nonce;
        var token = Token("google", nonce);
        var tokens = (await (await SignInAsync(client, "google", token, nonce)).Content.ReadFromJsonAsync<TokenResponse>())!;
        using var authed = host.CreateClient();
        authed.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tokens.AccessToken);

        // The same token and nonce, inside the 10 minutes the deletion re-check allows.
        using var replay = await DeleteAsync(authed, token, nonce);
        var fresh = (await NonceAsync(client)).Nonce;
        using var deleted = await DeleteAsync(authed, Token("google", fresh), fresh);

        Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
    }

    [Fact]
    public async Task A_deletion_re_check_uses_its_nonce_once()
    {
        using var host = await NewHostAsync();
        var userId = await host.CreateUserAsync();
        await host.WithDatabaseAsync(async db =>
        {
            db.ExternalLogins.Add(new ExternalLogin { Provider = LoginProviders.Google, Subject = GoogleSubject, UserId = userId, CreatedAt = clock.GetUtcNow() });
            return await db.SaveChangesAsync();
        });
        using var authed = host.CreateClient();
        authed.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            host.Services.GetRequiredService<IAccessTokenService>().Issue(userId).Value);
        var nonce = (await NonceAsync(authed)).Nonce;

        // Another person's Google account: refused, and the nonce is not used up by it.
        using var other = await DeleteAsync(authed, idp.Issue(clock, FakeIdentityProvider.GoogleIssuer, FakeIdentityProvider.GoogleAudience, "someone-else", rawNonce: nonce), nonce);
        using var unissued = await DeleteAsync(authed, Token("google", "never-issued"), "never-issued");
        Assert.True(await host.WithDatabaseAsync(db => db.Users.AsNoTracking().AnyAsync(u => u.Id == userId)));
        using var deleted = await DeleteAsync(authed, Token("google", nonce), nonce);

        Assert.Equal(HttpStatusCode.Forbidden, other.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, unissued.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
    }

    [Fact]
    public async Task The_cleanup_removes_expired_nonces_and_keeps_live_ones()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        await NonceAsync(client);
        clock.Advance(SignInNonces.Lifetime + TimeSpan.FromSeconds(1));
        var live = (await NonceAsync(client)).Nonce;

        await using var scope = host.Services.CreateAsyncScope();
        var removed = await scope.ServiceProvider.GetRequiredService<RefreshTokenCleanup>().RemoveExpiredNoncesAsync(CancellationToken.None);

        Assert.Equal(1, removed);
        var left = Assert.Single(await host.WithDatabaseAsync(db => db.Set<SignInNonce>().AsNoTracking().ToListAsync()));
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(live)), left.Hash);
    }

    [Fact]
    public async Task Nonces_are_never_logged()
    {
        using var host = await NewHostAsync();
        using var client = host.CreateClient();
        var used = (await NonceAsync(client)).Nonce;
        using var signIn = await SignInAsync(client, "google", Token("google", used), used);
        using var replay = await SignInAsync(client, "google", Token("google", used), used);

        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        Assert.Contains(host.Logs.Entries, e => e.Contains("NonceNotIssued", StringComparison.Ordinal));
        Assert.DoesNotContain(host.Logs.Entries, e => e.Contains(used, StringComparison.Ordinal));
        Assert.DoesNotContain(host.Logs.Entries, e => e.Contains(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(used))), StringComparison.Ordinal));
    }

    private string Token(string provider, string nonce) => provider == "apple"
        ? idp.Issue(clock, FakeIdentityProvider.AppleIssuer, FakeIdentityProvider.AppleAudience, "000123.abc", rawNonce: nonce)
        : idp.Issue(clock, FakeIdentityProvider.GoogleIssuer, FakeIdentityProvider.GoogleAudience, GoogleSubject, rawNonce: nonce);

    private static async Task<NonceResponse> NonceAsync(HttpClient client)
    {
        using var response = await client.PostAsync("/auth/nonce", content: null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<NonceResponse>())!;
    }

    private static Task<HttpResponseMessage> SignInAsync(HttpClient client, string provider, string idToken, string nonce) =>
        client.PostAsJsonAsync($"/auth/{provider}", new { idToken, nonce });

    private static async Task<HttpResponseMessage> DeleteAsync(HttpClient client, string idToken, string nonce)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, "/me")
        {
            Content = JsonContent.Create(new { idToken, nonce, authorizationCode = (string?)null }),
        };
        return await client.SendAsync(request);
    }

    private async Task<KyntraApiFactory> NewHostAsync() => new KyntraApiFactory(
        await postgres.CreateDatabaseAsync(),
        new Dictionary<string, string?>
        {
            ["Auth:Apple:Audiences:0"] = FakeIdentityProvider.AppleAudience,
            ["Auth:Google:Audiences:0"] = FakeIdentityProvider.GoogleAudience,
        },
        clock,
        services => services.Replace(ServiceDescriptor.Singleton<IOidcKeySource>(new FakeKeySource { Current = [idp.PublicKey] })));
}
