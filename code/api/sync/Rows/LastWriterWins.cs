// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using Kyntra.Persistence.Entities;

namespace Kyntra.Sync.Rows;

internal readonly record struct Decision<TEntity>(RowStatus Status, TEntity? Inserted, bool Changed)
    where TEntity : SyncRow;

/// <summary>
/// The conflict rules (architecture review, section 3), the same for every table:
/// <list type="bullet">
/// <item>A row the server has never seen is stored, including a deleted one, so a late edit
/// cannot bring it back.</item>
/// <item>A deleted row stays deleted. An edit of it is ignored.</item>
/// <item>A delete wins over an edit, whatever the times say.</item>
/// <item>Between two edits the later <c>updated_at</c> wins.</item>
/// <item>The same row sent again changes nothing, so a retry costs no write and no new
/// change number.</item>
/// </list>
/// </summary>
internal static class LastWriterWins
{
    public static Decision<TEntity> Decide<TRow, TEntity, TKey>(
        IRowMap<TRow, TEntity, TKey> map,
        Guid userId,
        TRow row,
        TEntity? existing)
        where TEntity : SyncRow
        where TKey : notnull
    {
        var deletedAt = RowRules.Time(map.DeletedAt(row));
        var updatedAt = RowRules.Time(map.UpdatedAt(row));

        if (existing is null)
        {
            return new Decision<TEntity>(RowStatus.Applied, map.Create(userId, row), Changed: true);
        }

        if (existing.DeletedAt is not null)
        {
            // Sending the delete again is a retry. Sending an edit is the loser of a conflict.
            return new Decision<TEntity>(deletedAt is null ? RowStatus.Deleted : RowStatus.Unchanged, null, Changed: false);
        }

        if (deletedAt is not null)
        {
            // The delete wins. The content comes along only if it is also the newer write.
            if (updatedAt >= existing.UpdatedAt)
            {
                map.CopyContent(row, existing);
                existing.UpdatedAt = updatedAt;
            }

            existing.DeletedAt = deletedAt;
            return new Decision<TEntity>(RowStatus.Applied, null, Changed: true);
        }

        if (updatedAt > existing.UpdatedAt)
        {
            map.CopyContent(row, existing);
            existing.UpdatedAt = updatedAt;
            return new Decision<TEntity>(RowStatus.Applied, null, Changed: true);
        }

        // The same time. The same content is a retry. Different content means two writes in the
        // same microsecond, and the server's copy stays.
        return new Decision<TEntity>(
            updatedAt == existing.UpdatedAt && map.SameContent(row, existing) ? RowStatus.Unchanged : RowStatus.Stale,
            null,
            Changed: false);
    }
}
