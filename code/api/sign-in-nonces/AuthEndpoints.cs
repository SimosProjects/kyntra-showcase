// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using Kyntra.Persistence;
using Kyntra.Persistence.Entities;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Kyntra.Users.Auth;

public static class AuthEndpoints
{
    public const string GroupPath = "/auth";

    // A refresh token is 43 characters. The cap keeps a hostile body from being hashed.
    private const int MaxTokenLength = 200;

    // Provider ID tokens are about 1 to 2 KB.
    private const int MaxIdTokenLength = 8192;

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup(GroupPath).WithTags("Auth");

        // A sign-in or deletion re-check starts here (ADR 0052). Signed out, so anonymous.
        group.MapPost("/nonce", async (ISignInNonces nonces, CancellationToken ct) => Results.Ok(await nonces.IssueAsync(ct)))
            .WithName("IssueSignInNonce")
            .AllowAnonymous()
            .RequireRateLimiting(AuthRateLimiting.PolicyName)
            .Produces<NonceResponse>();
        group.MapPost("/apple", (SignInRequest request, IEnumerable<IIdTokenValidator> validators, ISignInNonces nonces, ISignInService signIn, IAppleWebCodes webCodes, CancellationToken ct) =>
                SignInAsync(LoginProviders.Apple, WithWebCode(request, webCodes), validators, nonces, signIn, ct))
            .WithName("SignInWithApple")
            .AllowAnonymous()
            .RequireRateLimiting(AuthRateLimiting.PolicyName)
            .Produces<TokenResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesValidationProblem();
        group.MapPost("/google", (SignInRequest request, IEnumerable<IIdTokenValidator> validators, ISignInNonces nonces, ISignInService signIn, CancellationToken ct) =>
                SignInAsync(LoginProviders.Google, request, validators, nonces, signIn, ct))
            .WithName("SignInWithGoogle")
            .AllowAnonymous()
            .RequireRateLimiting(AuthRateLimiting.PolicyName)
            .Produces<TokenResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesValidationProblem();
        group.MapAppleNotifications();
        AppleWebCallback.Map(group);
        if (DevSignIn.IsEnabled(endpoints.ServiceProvider))
        {
            DevSignIn.Map(group);
        }

        group.MapPost("/refresh", RefreshAsync)
            .WithName("Refresh")
            .AllowAnonymous()
            .RequireRateLimiting(AuthRateLimiting.RefreshPolicyName)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .Produces<TokenResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesValidationProblem();
        group.MapPost("/logout", LogoutAsync)
            .WithName("Logout")
            .AllowAnonymous()
            .RequireRateLimiting(AuthRateLimiting.PolicyName)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesValidationProblem();
        return endpoints;
    }

    /// <summary>
    /// An Apple sign-in on Android sends the one-time code of Apple's web sign-in. Opened, it is Apple's ID token, and the
    /// sign-in goes on exactly as for an iPhone token. A code that does not open is treated as a bad token.
    /// </summary>
    private static SignInRequest WithWebCode(SignInRequest request, IAppleWebCodes codes)
    {
        if (request.Code is not { Length: > 0 } code)
        {
            return request;
        }

        if (!string.IsNullOrEmpty(request.IdToken))
        {
            return request with { Code = null, IdToken = null };
        }

        return request with { Code = null, IdToken = codes.Open(code)?.IdToken ?? NotAToken };
    }

    // Stands in for a code that did not open, so the validator refuses it like any bad token.
    private const string NotAToken = "invalid";

    internal static TokenResponse ToResponse(AccessToken access, IssuedRefreshToken refresh, string? epoch) =>
        new(access.Value, access.ExpiresAt, refresh.Value, refresh.ExpiresAt, epoch);

    private static async Task<IResult> SignInAsync(
        string provider,
        SignInRequest request,
        IEnumerable<IIdTokenValidator> validators,
        ISignInNonces nonces,
        ISignInService signIn,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request?.IdToken) || request.IdToken.Length > MaxIdTokenLength || request.Code is not null)
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                [nameof(SignInRequest.IdToken)] = ["An ID token is required."],
            });
        }

        var validator = validators.Single(v => v.Provider == provider);
        var result = await validator.ValidateAsync(request.IdToken, request.Nonce, cancellationToken);

        if (result.Identity is null)
        {
            // Every reason a token can be bad gets the same answer.
            return result.Failure == IdTokenFailure.Invalid
                ? InvalidToken()
                : Results.Problem(title: "Sign-in with this provider is not available right now.", statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        // The validator has checked the token carries this nonce. Using it last means a bad token never uses it up,
        // and a replayed token finds it gone.
        if (!await nonces.TryUseAsync(provider, request.Nonce!, cancellationToken))
        {
            return InvalidToken();
        }

        return Results.Ok(await signIn.SignInAsync(result.Identity, cancellationToken));
    }

    private static IResult InvalidToken() =>
        Results.Problem(title: "The sign-in token is not valid.", statusCode: StatusCodes.Status401Unauthorized);

    private static async Task<IResult> RefreshAsync(
        RefreshRequest request,
        IRefreshTokenService refreshTokens,
        IAccessTokenService accessTokens,
        IDataEpoch epoch,
        CancellationToken cancellationToken)
    {
        if (Invalid(request) is { } problem)
        {
            return problem;
        }

        var outcome = await refreshTokens.RotateAsync(request.RefreshToken!, cancellationToken);
        if (outcome.Failure == RefreshFailure.RateLimited)
        {
            return new RetryAfterResult(outcome.RetryAfter);
        }

        if (!outcome.Succeeded)
        {
            // Reuse and an unknown token look the same to the caller.
            return Results.Problem(
                title: "The refresh token is not valid.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var token = outcome.Token!;
        return Results.Ok(ToResponse(accessTokens.Issue(token.UserId), token, await epoch.GetAsync(cancellationToken)));
    }

    private static async Task<IResult> LogoutAsync(
        RefreshRequest request,
        IRefreshTokenService refreshTokens,
        CancellationToken cancellationToken)
    {
        if (Invalid(request) is { } problem)
        {
            return problem;
        }

        // Always 204, so the response says nothing about whether the token was real. The caller
        // may have no valid access token left, so the refresh token alone identifies the session.
        await refreshTokens.RevokeFamilyAsync(request.RefreshToken!, cancellationToken);
        return Results.NoContent();
    }

    private static IResult? Invalid(RefreshRequest? request) =>
        string.IsNullOrWhiteSpace(request?.RefreshToken) || request.RefreshToken.Length > MaxTokenLength
            ? Results.ValidationProblem(new Dictionary<string, string[]>
            {
                [nameof(RefreshRequest.RefreshToken)] = ["A refresh token is required."],
            })
            : null;

    /// <summary>A 429 with Retry-After, the same shape as the rate limiter's own answer.</summary>
    private sealed class RetryAfterResult(TimeSpan retryAfter) : IResult
    {
        public Task ExecuteAsync(HttpContext httpContext)
        {
            httpContext.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return Results.Problem(title: "Too many requests.", statusCode: StatusCodes.Status429TooManyRequests).ExecuteAsync(httpContext);
        }
    }
}
