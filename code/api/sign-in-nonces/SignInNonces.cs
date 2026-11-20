// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using System.Security.Cryptography;
using System.Text;
using Kyntra.Persistence;
using Kyntra.Persistence.Entities;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Kyntra.Users.Auth;

/// <summary>A nonce for one sign-in or deletion re-check. The app gives it to Apple or Google and sends it back.</summary>
public sealed record NonceResponse(string Nonce, DateTimeOffset ExpiresAt);

/// <summary>Nonces the server issues and accepts once each (ADR 0052).</summary>
public interface ISignInNonces
{
    Task<NonceResponse> IssueAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Uses the nonce: true when the server issued it, it has not expired and it was not used before. Called only once
    /// the provider's token is otherwise valid, so a bad token does not use it up.
    /// </summary>
    Task<bool> TryUseAsync(string provider, string nonce, CancellationToken cancellationToken);

    /// <summary>
    /// True when a nonce with this SHA-256 was issued and is neither used nor expired. It is not used up. For Apple's web
    /// sign-in, whose callback sees only the nonce's hash (ADR 0053).
    /// </summary>
    Task<bool> IsIssuedAsync(byte[] hash, CancellationToken cancellationToken);
}

public sealed partial class SignInNonces(KyntraDbContext database, TimeProvider time, ILogger<SignInNonces> logger) : ISignInNonces
{
    /// <summary>Long enough to finish the provider's sheet, and the same as the deletion re-check's limit.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    public async Task<NonceResponse> IssueAsync(CancellationToken cancellationToken)
    {
        var value = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var expiresAt = time.GetUtcNow().Add(Lifetime);
        database.Set<SignInNonce>().Add(new SignInNonce { Hash = Hash(value), ExpiresAt = expiresAt });
        await database.SaveChangesAsync(cancellationToken);
        return new NonceResponse(value, expiresAt);
    }

    public async Task<bool> TryUseAsync(string provider, string nonce, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(nonce);

        // One statement, so two requests with the same nonce cannot both remove the row.
        var hash = Hash(nonce);
        var now = time.GetUtcNow();
        var used = await database.Set<SignInNonce>()
            .Where(n => n.Hash == hash && n.ExpiresAt > now)
            .ExecuteDeleteAsync(cancellationToken) == 1;
        if (!used)
        {
            LogNotIssued(logger, provider);
        }

        return used;
    }

    public async Task<bool> IsIssuedAsync(byte[] hash, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(hash);
        var now = time.GetUtcNow();
        return await database.Set<SignInNonce>().AnyAsync(n => n.Hash == hash && n.ExpiresAt > now, cancellationToken);
    }

    internal static byte[] Hash(string nonce) => SHA256.HashData(Encoding.UTF8.GetBytes(nonce));

    [LoggerMessage(Level = LogLevel.Information, Message = "ID token rejected for {Provider}: NonceNotIssued.")]
    private static partial void LogNotIssued(ILogger logger, string provider);
}
