// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using Kyntra.Persistence;
using Kyntra.Persistence.Entities;

namespace Kyntra.Sync.Rows;

/// <summary>
/// What is specific to one table. The rules for ordering, deletion and replay are the same for all
/// of them and live in <see cref="LastWriterWins"/>.
/// </summary>
internal interface IRowMap<TRow, TEntity, TKey>
    where TEntity : SyncRow
    where TKey : notnull
{
    TKey Key(TRow row);

    TKey Key(TEntity entity);

    /// <summary>The id of the parent row, for tables that have one.</summary>
    Guid? ParentId(TRow row);

    DateTimeOffset CreatedAt(TRow row);

    DateTimeOffset UpdatedAt(TRow row);

    DateTimeOffset? DeletedAt(TRow row);

    /// <summary>A reason the row can never be accepted as it is, or null. Timestamps are checked against <paramref name="latest"/>.</summary>
    string? Validate(TRow row, DateTimeOffset latest);

    TEntity Create(Guid userId, TRow row);

    void CopyContent(TRow row, TEntity entity);

    bool SameContent(TRow row, TEntity entity);

    /// <summary>The user's existing rows with these keys, tracked so they can be updated.</summary>
    IQueryable<TEntity> Existing(KyntraDbContext database, Guid userId, IReadOnlyCollection<TKey> keys);
}
