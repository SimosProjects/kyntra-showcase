// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using System.Data;
using Kyntra.Persistence;
using Kyntra.Persistence.Entities;
using Kyntra.Sync.Rows;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Kyntra.Sync;

public interface ISyncService
{
    /// <summary>Applies a batch of rows for the user. The caller has already checked the batch limits.</summary>
    Task<PushResponse> PushAsync(Guid userId, PushRequest request, CancellationToken cancellationToken);

    /// <summary>The user's rows that changed after <paramref name="since"/>, oldest change first, at most <paramref name="limit"/>.</summary>
    Task<ChangesResponse> ChangesAsync(Guid userId, long since, int limit, CancellationToken cancellationToken);
}

/// <summary>
/// Every query filters by the user id passed in, which comes from the access token. A push
/// holds a per user advisory lock for the length of its transaction. That serializes the user's
/// pushes, so rows get their change numbers in the order they commit. Without it, two pushes could
/// commit out of number order, and a pull between them would move its cursor past a row that was
/// about to appear and never return it. A pull reads all its tables in one snapshot, so it sees
/// a whole number of pushes and never half of one.
/// </summary>
public sealed partial class SyncService(
    KyntraDbContext database,
    IDataEpoch epoch,
    IOptions<SyncOptions> options,
    TimeProvider time,
    ILogger<SyncService> logger) : ISyncService
{
    private static readonly WorkoutMap Workouts = new();
    private static readonly WorkoutExerciseMap Exercises = new();
    private static readonly WorkoutSetMap Sets = new();
    private static readonly PreferenceMap Preferences = new();
    private static readonly PlanMap PlanRows = new();
    private static readonly PlanExerciseMap PlanExerciseRows = new();
    private static readonly CustomExerciseMap CustomExerciseRows = new();

    private readonly record struct Outcome<TKey>(TKey Key, RowStatus Status, long ServerVersion, string? Reason);

    public async Task<PushResponse> PushAsync(Guid userId, PushRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var latest = time.GetUtcNow().AddHours(options.Value.MaxFutureSkewHours);

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        await database.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({userId.ToString("N")}, 0))",
            cancellationToken);

        var changed = new List<SyncRow>();

        // New rows a person may still add today. Updates to rows they have do not use it.
        var day = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        var usedToday = await database.Set<SyncDailyUsage>().AsNoTracking()
            .Where(u => u.UserId == userId && u.Day == day)
            .Select(u => u.NewRows)
            .FirstOrDefaultAsync(cancellationToken);
        var allowance = new NewRowAllowance(options.Value.MaxNewRowsPerDay - usedToday);

        // Parents first, so a child that arrives with its parent in the same batch finds it.
        var workoutRows = await WithoutOthersPrivateGymsAsync(userId, request.Workouts ?? [], cancellationToken);
        var workouts = await ProcessAsync(
            Workouts, userId, workoutRows, latest, null, changed, cancellationToken, (await WorkoutsOverLimitAsync(userId, workoutRows, cancellationToken)).Contains, allowance);

        var exerciseRows = request.WorkoutExercises ?? [];
        var knownWorkouts = await KnownWorkoutsAsync(userId, exerciseRows.Select(r => r.WorkoutId), cancellationToken);
        var exercises = await ProcessAsync(Exercises, userId, exerciseRows, latest, knownWorkouts, changed, cancellationToken, allowance: allowance);

        var setRows = request.WorkoutSets ?? [];
        var knownExercises = await KnownExercisesAsync(userId, setRows.Select(r => r.WorkoutExerciseId), cancellationToken);
        var sets = await ProcessAsync(
            Sets, userId, setRows, latest, knownExercises, changed, cancellationToken, (await SetsOverLimitAsync(userId, setRows, cancellationToken)).Contains, allowance);

        var preferenceRows = request.Preferences ?? [];
        var preferences = await ProcessAsync(
            Preferences, userId, preferenceRows, latest, null, changed, cancellationToken, (await PreferencesOverLimitAsync(userId, preferenceRows, cancellationToken)).Contains, allowance);

        // Plans before their exercises, and past the limits a new row is rejected, not stored.
        var planRows = request.Plans ?? [];
        var plans = await ProcessAsync(PlanRows, userId, planRows, latest, null, changed, cancellationToken, (await PlansOverLimitAsync(userId, planRows, cancellationToken)).Contains, allowance);

        var planExerciseRows = request.PlanExercises ?? [];
        var knownPlans = await KnownPlansAsync(userId, planExerciseRows.Select(r => r.PlanId), cancellationToken);
        var planExercises = await ProcessAsync(
            PlanExerciseRows, userId, planExerciseRows, latest, knownPlans, changed, cancellationToken, (await PlanExercisesOverLimitAsync(userId, planExerciseRows, cancellationToken)).Contains, allowance);

        var customRows = request.CustomExercises ?? [];
        var customExercises = await ProcessAsync(
            CustomExerciseRows, userId, customRows, latest, null, changed, cancellationToken, (await CustomExercisesOverLimitAsync(userId, customRows, cancellationToken)).Contains, allowance);

        if (allowance.Taken > 0)
        {
            // The first new rows of a day clear this person's older days, so the table holds about one row per person.
            if (usedToday == 0)
            {
                await database.Set<SyncDailyUsage>().Where(u => u.UserId == userId && u.Day < day).ExecuteDeleteAsync(cancellationToken);
            }

            await database.Database.ExecuteSqlAsync(
                $"""
                INSERT INTO sync_daily_usage (user_id, day, new_rows) VALUES ({userId}, {day}, {allowance.Taken})
                ON CONFLICT (user_id, day) DO UPDATE SET new_rows = sync_daily_usage.new_rows + {allowance.Taken}
                """,
                cancellationToken);
        }

        await AssignChangeNumbersAsync(changed, cancellationToken);
        await database.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        var all = workouts.Select(o => o.Status)
            .Concat(exercises.Select(o => o.Status))
            .Concat(sets.Select(o => o.Status))
            .Concat(preferences.Select(o => o.Status))
            .Concat(plans.Select(o => o.Status))
            .Concat(planExercises.Select(o => o.Status))
            .Concat(customExercises.Select(o => o.Status))
            .ToList();
        var applied = Count(all, RowStatus.Applied);
        var unchanged = Count(all, RowStatus.Unchanged);
        var stale = Count(all, RowStatus.Stale);
        var deleted = Count(all, RowStatus.Deleted);
        var rejected = Count(all, RowStatus.Rejected);
        LogPush(logger, applied, unchanged, stale, deleted, rejected);

        return new PushResponse(
            [.. workouts.Select(o => new RowResult(o.Key, o.ServerVersion, o.Status, o.Reason))],
            [.. exercises.Select(o => new RowResult(o.Key, o.ServerVersion, o.Status, o.Reason))],
            [.. sets.Select(o => new RowResult(o.Key, o.ServerVersion, o.Status, o.Reason))],
            [.. preferences.Select(o => new PreferenceResult(o.Key ?? string.Empty, o.ServerVersion, o.Status, o.Reason))],
            [.. plans.Select(o => new RowResult(o.Key, o.ServerVersion, o.Status, o.Reason))],
            [.. planExercises.Select(o => new RowResult(o.Key, o.ServerVersion, o.Status, o.Reason))],
            [.. customExercises.Select(o => new RowResult(o.Key, o.ServerVersion, o.Status, o.Reason))],
            await epoch.GetAsync(cancellationToken));
    }

    public async Task<ChangesResponse> ChangesAsync(Guid userId, long since, int limit, CancellationToken cancellationToken)
    {
        // One snapshot for all four queries. At the default isolation each query sees whatever has
        // committed by the time it runs, so a push that commits in between could show its exercise
        // but not its workout, and the cursor would move past a row that is never returned.
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);

        // Each table gives its oldest rows after the cursor. The merged first page cannot be
        // missing an older row from a table, because a table that was cut off at the limit
        // only has newer rows left.
        var workouts = await database.Workouts.AsNoTracking()
            .Where(w => w.UserId == userId && w.ChangeSeq > since).OrderBy(w => w.ChangeSeq).Take(limit).ToListAsync(cancellationToken);
        var exercises = await database.WorkoutExercises.AsNoTracking()
            .Where(e => e.UserId == userId && e.ChangeSeq > since).OrderBy(e => e.ChangeSeq).Take(limit).ToListAsync(cancellationToken);
        var sets = await database.WorkoutSets.AsNoTracking()
            .Where(s => s.UserId == userId && s.ChangeSeq > since).OrderBy(s => s.ChangeSeq).Take(limit).ToListAsync(cancellationToken);
        var preferences = await database.Preferences.AsNoTracking()
            .Where(p => p.UserId == userId && p.ChangeSeq > since).OrderBy(p => p.ChangeSeq).Take(limit).ToListAsync(cancellationToken);

        var plans = await database.Plans.AsNoTracking()
            .Where(p => p.UserId == userId && p.ChangeSeq > since).OrderBy(p => p.ChangeSeq).Take(limit).ToListAsync(cancellationToken);
        var planExercises = await database.PlanExercises.AsNoTracking()
            .Where(e => e.UserId == userId && e.ChangeSeq > since).OrderBy(e => e.ChangeSeq).Take(limit).ToListAsync(cancellationToken);

        var customExercises = await database.CustomExercises.AsNoTracking()
            .Where(e => e.UserId == userId && e.ChangeSeq > since).OrderBy(e => e.ChangeSeq).Take(limit).ToListAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);

        var merged = workouts.Cast<SyncRow>()
            .Concat(exercises)
            .Concat(sets)
            .Concat(preferences)
            .Concat(plans)
            .Concat(planExercises)
            .Concat(customExercises)
            .OrderBy(r => r.ChangeSeq)
            .ToList();

        var page = merged.Take(limit).ToList();
        var hasMore = merged.Count > limit
            || workouts.Count == limit
            || exercises.Count == limit
            || sets.Count == limit
            || preferences.Count == limit
            || plans.Count == limit
            || planExercises.Count == limit
            || customExercises.Count == limit;

        return new ChangesResponse(
            page.Count == 0 ? since : page[^1].ChangeSeq,
            hasMore,
            [.. page.OfType<Workout>().Select(Changes.ToChange)],
            [.. page.OfType<WorkoutExercise>().Select(Changes.ToChange)],
            [.. page.OfType<WorkoutSet>().Select(Changes.ToChange)],
            [.. page.OfType<Preference>().Select(Changes.ToChange)],
            [.. page.OfType<Plan>().Select(Changes.ToChange)],
            [.. page.OfType<PlanExercise>().Select(Changes.ToChange)],
            [.. page.OfType<CustomExercise>().Select(Changes.ToChange)],
            await epoch.GetAsync(cancellationToken));
    }

    private static int Count(List<RowStatus> all, RowStatus status) => all.Count(s => s == status);

    private async Task<List<Outcome<TKey>>> ProcessAsync<TRow, TEntity, TKey>(
        IRowMap<TRow, TEntity, TKey> map,
        Guid userId,
        IReadOnlyList<TRow> rows,
        DateTimeOffset latest,
        HashSet<Guid>? knownParents,
        List<SyncRow> changed,
        CancellationToken cancellationToken,
        Func<TKey, bool>? overLimit = null,
        NewRowAllowance? allowance = null)
        where TEntity : SyncRow
        where TKey : notnull
    {
        var reasons = rows
            .Select(row => map.Validate(row, latest)
                ?? (knownParents is not null && map.ParentId(row) is { } parent && !knownParents.Contains(parent)
                    ? RejectionReasons.MissingParent
                    : overLimit is not null && overLimit(map.Key(row)) ? RejectionReasons.LimitReached : null))
            .ToList();

        var keys = rows.Where((_, i) => reasons[i] is null).Select(map.Key).ToList();
        var existing = keys.Count == 0
            ? []
            : (await map.Existing(database, userId, keys).ToListAsync(cancellationToken)).ToDictionary(map.Key);

        var outcomes = new List<Outcome<TKey>>(rows.Count);
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (reasons[i] is { } reason)
            {
                outcomes.Add(new Outcome<TKey>(map.Key(row), RowStatus.Rejected, 0, reason));
                continue;
            }

            var key = map.Key(row);
            existing.TryGetValue(key, out var current);
            var decision = LastWriterWins.Decide(map, userId, row, current);

            if (decision.Inserted is not null && allowance is not null && !allowance.TryTake())
            {
                outcomes.Add(new Outcome<TKey>(key, RowStatus.Rejected, 0, RejectionReasons.LimitReached));
                continue;
            }

            if (decision.Inserted is { } inserted)
            {
                database.Add(inserted);
                changed.Add(inserted);
                current = inserted;
            }
            else if (decision.Changed)
            {
                current!.ServerVersion++;
                changed.Add(current);
            }

            outcomes.Add(new Outcome<TKey>(key, decision.Status, current?.ServerVersion ?? 0, null));
        }

        return outcomes;
    }

    // A parent counts if it is already tracked (loaded or added in this batch) or exists in the
    // database for this user. Another user's row is invisible here, so naming it is the same as
    // naming a row that does not exist.
    private async Task<HashSet<Guid>> KnownWorkoutsAsync(Guid userId, IEnumerable<Guid> referenced, CancellationToken cancellationToken)
    {
        var known = database.Workouts.Local.Where(w => w.UserId == userId).Select(w => w.Id).ToHashSet();
        var missing = referenced.Where(id => !known.Contains(id)).Distinct().ToList();
        if (missing.Count > 0)
        {
            known.UnionWith(await database.Workouts.AsNoTracking()
                .Where(w => w.UserId == userId && missing.Contains(w.Id)).Select(w => w.Id).ToListAsync(cancellationToken));
        }

        return known;
    }

    private async Task<HashSet<Guid>> KnownPlansAsync(Guid userId, IEnumerable<Guid> referenced, CancellationToken cancellationToken)
    {
        var known = database.Plans.Local.Where(p => p.UserId == userId).Select(p => p.Id).ToHashSet();
        var missing = referenced.Where(id => !known.Contains(id)).Distinct().ToList();
        if (missing.Count > 0)
        {
            known.UnionWith(await database.Plans.AsNoTracking()
                .Where(p => p.UserId == userId && missing.Contains(p.Id)).Select(p => p.Id).ToListAsync(cancellationToken));
        }

        return known;
    }

    // The new, live plans in this batch that would take the person past the limit. A plan they already have, or
    // one that arrives deleted, is not a new plan.
    private async Task<HashSet<Guid>> PlansOverLimitAsync(Guid userId, IReadOnlyList<PlanRow> rows, CancellationToken cancellationToken)
    {
        var over = new HashSet<Guid>();
        if (rows.Count == 0)
        {
            return over;
        }

        var keys = rows.Select(r => r.Id).ToList();
        var have = await database.Plans.AsNoTracking().Where(p => p.UserId == userId && keys.Contains(p.Id)).Select(p => p.Id).ToListAsync(cancellationToken);
        var live = await database.Plans.CountAsync(p => p.UserId == userId && p.DeletedAt == null, cancellationToken);
        var room = options.Value.MaxPlansPerUser - live;
        foreach (var row in rows.Where(r => r.DeletedAt is null && !have.Contains(r.Id)))
        {
            if (room-- <= 0)
            {
                over.Add(row.Id);
            }
        }

        return over;
    }

    // A workout may name a public gym or one of the person's own, or a gym the server does not have yet (a gym added on
    // the phone that is still on its way). Another person's private gym is dropped from the row: it is not theirs to
    // see, and it would count toward that gym's people.
    private async Task<IReadOnlyList<WorkoutRow>> WithoutOthersPrivateGymsAsync(Guid userId, IReadOnlyList<WorkoutRow> rows, CancellationToken cancellationToken)
    {
        var named = rows.Where(r => r.GymId is not null).Select(r => r.GymId!.Value).Distinct().ToList();
        if (named.Count == 0)
        {
            return rows;
        }

        var hidden = await database.Gyms.AsNoTracking()
            .Where(g => named.Contains(g.Id) && g.Visibility == GymVisibilities.Private && g.CreatedBy != userId)
            .Select(g => g.Id)
            .ToListAsync(cancellationToken);
        return hidden.Count == 0 ? rows : [.. rows.Select(r => r.GymId is { } id && hidden.Contains(id) ? r with { GymId = null } : r)];
    }

    // The new, live workouts in this batch that would take the person past the limit.
    private async Task<HashSet<Guid>> WorkoutsOverLimitAsync(Guid userId, IReadOnlyList<WorkoutRow> rows, CancellationToken cancellationToken)
    {
        var over = new HashSet<Guid>();
        if (rows.Count == 0)
        {
            return over;
        }

        var keys = rows.Select(r => r.Id).ToList();
        var have = await database.Workouts.AsNoTracking().Where(w => w.UserId == userId && keys.Contains(w.Id)).Select(w => w.Id).ToListAsync(cancellationToken);
        var live = await database.Workouts.CountAsync(w => w.UserId == userId && w.DeletedAt == null, cancellationToken);
        var room = options.Value.MaxWorkoutsPerUser - live;
        foreach (var row in rows.Where(r => r.DeletedAt is null && !have.Contains(r.Id)))
        {
            if (room-- <= 0)
            {
                over.Add(row.Id);
            }
        }

        return over;
    }

    // The new, live sets in this batch that would take an exercise of a workout past the limit.
    private async Task<HashSet<Guid>> SetsOverLimitAsync(Guid userId, IReadOnlyList<WorkoutSetRow> rows, CancellationToken cancellationToken)
    {
        var over = new HashSet<Guid>();
        if (rows.Count == 0)
        {
            return over;
        }

        var keys = rows.Select(r => r.Id).ToList();
        var parents = rows.Select(r => r.WorkoutExerciseId).Distinct().ToList();
        var have = await database.WorkoutSets.AsNoTracking().Where(s => s.UserId == userId && keys.Contains(s.Id)).Select(s => s.Id).ToListAsync(cancellationToken);
        var live = await database.WorkoutSets.AsNoTracking()
            .Where(s => s.UserId == userId && parents.Contains(s.WorkoutExerciseId) && s.DeletedAt == null)
            .GroupBy(s => s.WorkoutExerciseId)
            .Select(g => new { Parent = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Parent, x => x.Count, cancellationToken);
        var max = options.Value.MaxSetsPerExercise;
        foreach (var row in rows.Where(r => r.DeletedAt is null && !have.Contains(r.Id)))
        {
            var count = live.GetValueOrDefault(row.WorkoutExerciseId);
            if (count >= max)
            {
                over.Add(row.Id);
            }
            else
            {
                live[row.WorkoutExerciseId] = count + 1;
            }
        }

        return over;
    }

    // New preference keys in this batch that would take the person past the limit.
    private async Task<HashSet<string>> PreferencesOverLimitAsync(Guid userId, IReadOnlyList<PreferenceRow> rows, CancellationToken cancellationToken)
    {
        var over = new HashSet<string>(StringComparer.Ordinal);
        if (rows.Count == 0)
        {
            return over;
        }

        var keys = rows.Select(r => r.Key).ToList();
        var have = await database.Preferences.AsNoTracking().Where(p => p.UserId == userId && keys.Contains(p.Key)).Select(p => p.Key).ToListAsync(cancellationToken);
        var live = await database.Preferences.CountAsync(p => p.UserId == userId && p.DeletedAt == null, cancellationToken);
        var room = options.Value.MaxPreferencesPerUser - live;
        foreach (var row in rows.Where(r => r.DeletedAt is null && !have.Contains(r.Key, StringComparer.Ordinal)))
        {
            if (room-- <= 0)
            {
                over.Add(row.Key);
            }
        }

        return over;
    }

    // The new, live custom exercises in this batch that would take the person past the limit.
    private async Task<HashSet<Guid>> CustomExercisesOverLimitAsync(Guid userId, IReadOnlyList<CustomExerciseRow> rows, CancellationToken cancellationToken)
    {
        var over = new HashSet<Guid>();
        if (rows.Count == 0)
        {
            return over;
        }

        var keys = rows.Select(r => r.Id).ToList();
        var have = await database.CustomExercises.AsNoTracking().Where(e => e.UserId == userId && keys.Contains(e.Id)).Select(e => e.Id).ToListAsync(cancellationToken);
        var live = await database.CustomExercises.CountAsync(e => e.UserId == userId && e.DeletedAt == null, cancellationToken);
        var room = options.Value.MaxCustomExercisesPerUser - live;
        foreach (var row in rows.Where(r => r.DeletedAt is null && !have.Contains(r.Id)))
        {
            if (room-- <= 0)
            {
                over.Add(row.Id);
            }
        }

        return over;
    }

    private async Task<HashSet<Guid>> PlanExercisesOverLimitAsync(Guid userId, IReadOnlyList<PlanExerciseRow> rows, CancellationToken cancellationToken)
    {
        var over = new HashSet<Guid>();
        if (rows.Count == 0)
        {
            return over;
        }

        var keys = rows.Select(r => r.Id).ToList();
        var plans = rows.Select(r => r.PlanId).Distinct().ToList();
        var have = await database.PlanExercises.AsNoTracking().Where(e => e.UserId == userId && keys.Contains(e.Id)).Select(e => e.Id).ToListAsync(cancellationToken);
        var live = await database.PlanExercises.AsNoTracking()
            .Where(e => e.UserId == userId && plans.Contains(e.PlanId) && e.DeletedAt == null)
            .GroupBy(e => e.PlanId)
            .Select(g => new { PlanId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.PlanId, x => x.Count, cancellationToken);
        var max = options.Value.MaxExercisesPerPlan;
        foreach (var row in rows.Where(r => r.DeletedAt is null && !have.Contains(r.Id)))
        {
            var count = live.GetValueOrDefault(row.PlanId);
            if (count >= max)
            {
                over.Add(row.Id);
            }
            else
            {
                live[row.PlanId] = count + 1;
            }
        }

        return over;
    }

    private async Task<HashSet<Guid>> KnownExercisesAsync(Guid userId, IEnumerable<Guid> referenced, CancellationToken cancellationToken)
    {
        var known = database.WorkoutExercises.Local.Where(e => e.UserId == userId).Select(e => e.Id).ToHashSet();
        var missing = referenced.Where(id => !known.Contains(id)).Distinct().ToList();
        if (missing.Count > 0)
        {
            known.UnionWith(await database.WorkoutExercises.AsNoTracking()
                .Where(e => e.UserId == userId && missing.Contains(e.Id)).Select(e => e.Id).ToListAsync(cancellationToken));
        }

        return known;
    }

    private async Task AssignChangeNumbersAsync(List<SyncRow> changed, CancellationToken cancellationToken)
    {
        if (changed.Count == 0)
        {
            return;
        }

        var numbers = await database.Database
            .SqlQuery<long>($"SELECT nextval('change_seq') AS \"Value\" FROM generate_series(1, {changed.Count})")
            .ToListAsync(cancellationToken);
        numbers.Sort();

        for (var i = 0; i < changed.Count; i++)
        {
            changed[i].ChangeSeq = numbers[i];
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Sync push: {Applied} applied, {Unchanged} unchanged, {Stale} stale, {Deleted} deleted, {Rejected} rejected.")]
    private static partial void LogPush(ILogger logger, int applied, int unchanged, int stale, int deleted, int rejected);
}

/// <summary>The new rows a push may still add today. Each insert takes one; past zero a new row is rejected.</summary>
internal sealed class NewRowAllowance(int remaining)
{
    private int left = remaining;

    public int Taken { get; private set; }

    public bool TryTake()
    {
        if (left <= 0)
        {
            return false;
        }

        left--;
        Taken++;
        return true;
    }
}
