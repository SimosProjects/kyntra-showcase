// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using System.Net;
using System.Net.Http.Json;
using System.Text;
using Kyntra.Api.Tests.Infrastructure;
using Kyntra.Sync;

namespace Kyntra.Api.Tests;

[Collection(PostgresTestGroup.Name)]
public sealed class SyncPushTests(PostgresFixture postgres)
{
    private static readonly TimeSpan Day = TimeSpan.FromDays(1);

    // Storing rows

    [Fact]
    public async Task A_new_batch_is_stored_for_the_caller_with_version_1()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        var userId = await h.NewUserAsync();
        using var client = h.ClientFor(userId);
        var workout = h.Workout(notes: "my notes");
        var exercise = h.Exercise(workout.Id);
        var set = h.Set(exercise.Id);
        var preference = h.Preference();

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [exercise], [set], [preference]));

        Assert.Equal([new RowResult(workout.Id, 1, RowStatus.Applied, null)], result.Workouts);
        Assert.Equal([new RowResult(exercise.Id, 1, RowStatus.Applied, null)], result.WorkoutExercises);
        Assert.Equal([new RowResult(set.Id, 1, RowStatus.Applied, null)], result.WorkoutSets);
        Assert.Equal([new PreferenceResult("default_unit", 1, RowStatus.Applied, null)], result.Preferences);

        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.Equal((userId, "my notes", "Europe/Madrid"), (stored.UserId, stored.Notes, stored.TimeZone));
        Assert.Equal(userId, Assert.Single(await h.StoredExercisesAsync()).UserId);
        Assert.Equal(userId, Assert.Single(await h.StoredSetsAsync()).UserId);
        Assert.Equal("kg", Assert.Single(await h.StoredPreferencesAsync()).Value);
    }

    [Fact]
    public async Task Weights_are_stored_exactly_as_entered_beside_the_kilogram_value()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workout = h.Workout();
        var exercise = h.Exercise(workout.Id);
        var pounds = h.Set(exercise.Id, weightValue: 40m, weightUnit: "lb", weightKg: 18.14369m);
        var kilos = h.Set(exercise.Id, weightValue: 52.5m, weightUnit: "kg", weightKg: 52.5m);
        var bodyweight = h.Set(exercise.Id, weightValue: null, weightUnit: null, weightKg: null, reps: 15);

        await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [exercise], [pounds, kilos, bodyweight]));

        var stored = (await h.StoredSetsAsync()).ToDictionary(s => s.Id);
        Assert.Equal((40m, "lb", 18.1437m), (stored[pounds.Id].WeightValue, stored[pounds.Id].WeightUnit, stored[pounds.Id].WeightKg));
        Assert.Equal((52.5m, "kg", 52.5m), (stored[kilos.Id].WeightValue, stored[kilos.Id].WeightUnit, stored[kilos.Id].WeightKg));
        Assert.Equal((null, null, null), (stored[bodyweight.Id].WeightValue, stored[bodyweight.Id].WeightUnit, stored[bodyweight.Id].WeightKg));

        // Sent again, the rounded kilograms still count as the same row.
        var replay = await SyncHarness.PushAsync(client, SyncHarness.Batch(sets: [pounds]));
        Assert.Equal(RowStatus.Unchanged, replay.WorkoutSets[0].Status);
    }

    [Fact]
    public async Task Change_numbers_rise_in_the_order_rows_were_applied_parents_first()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workout = h.Workout();
        var exercise = h.Exercise(workout.Id);
        var set = h.Set(exercise.Id);

        await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [exercise], [set], [h.Preference()]));

        var seqs = new[]
        {
            (await h.StoredWorkoutsAsync()).Single().ChangeSeq,
            (await h.StoredExercisesAsync()).Single().ChangeSeq,
            (await h.StoredSetsAsync()).Single().ChangeSeq,
            (await h.StoredPreferencesAsync()).Single().ChangeSeq,
        };
        Assert.Equal(seqs.Order(), seqs);
        Assert.Equal(4, seqs.Distinct().Count());
    }

    [Fact]
    public async Task The_same_batch_pushed_three_times_creates_no_duplicates_and_changes_nothing()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workout = h.Workout();
        var exercise = h.Exercise(workout.Id);
        var set = h.Set(exercise.Id);
        var batch = SyncHarness.Batch([workout], [exercise], [set], [h.Preference()]);

        var first = await SyncHarness.PushAsync(client, batch);
        var before = (await h.StoredWorkoutsAsync()).Single().ChangeSeq;
        var second = await SyncHarness.PushAsync(client, batch);
        var third = await SyncHarness.PushAsync(client, batch);

        Assert.Equal(RowStatus.Applied, first.Workouts[0].Status);
        foreach (var replay in new[] { second, third })
        {
            Assert.Equal(RowStatus.Unchanged, replay.Workouts[0].Status);
            Assert.Equal(RowStatus.Unchanged, replay.WorkoutExercises[0].Status);
            Assert.Equal(RowStatus.Unchanged, replay.WorkoutSets[0].Status);
            Assert.Equal(RowStatus.Unchanged, replay.Preferences[0].Status);
            Assert.Equal(1, replay.Workouts[0].ServerVersion);
        }

        Assert.Single(await h.StoredWorkoutsAsync());
        Assert.Single(await h.StoredExercisesAsync());
        Assert.Single(await h.StoredSetsAsync());
        Assert.Single(await h.StoredPreferencesAsync());

        // A replay writes nothing, so nothing new appears for a pull either.
        Assert.Equal(before, (await h.StoredWorkoutsAsync()).Single().ChangeSeq);
        var changes = await SyncHarness.PullAsync(client, since: (await h.StoredPreferencesAsync()).Single().ChangeSeq);
        Assert.Empty(changes.Workouts);
    }

    [Fact]
    public async Task A_replay_that_differs_only_in_sub_microsecond_ticks_is_still_the_same_row()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workout = h.Workout(updated: h.Now.AddTicks(7));

        await SyncHarness.PushAsync(client, SyncHarness.Batch([workout]));
        var replay = await SyncHarness.PushAsync(client, SyncHarness.Batch([workout]));

        Assert.Equal(RowStatus.Unchanged, replay.Workouts[0].Status);
    }

    [Fact]
    public async Task Times_with_a_utc_offset_are_stored_as_the_same_instant_and_replay_as_unchanged()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();
        var inSpain = new DateTimeOffset(2026, 10, 5, 14, 0, 0, TimeSpan.FromHours(2)); // 12:00 UTC, the clock's time
        var inNewYork = new DateTimeOffset(2026, 10, 5, 8, 0, 0, TimeSpan.FromHours(-4)); // the same instant

        var first = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, created: inSpain, updated: inSpain)]));
        var replay = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, created: inNewYork, updated: inNewYork)]));

        Assert.Equal(RowStatus.Applied, first.Workouts[0].Status);
        Assert.Equal(RowStatus.Unchanged, replay.Workouts[0].Status);
        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.Equal(h.Now, stored.UpdatedAt);
        Assert.Equal(TimeSpan.Zero, stored.UpdatedAt.Offset);
    }

    [Fact]
    public async Task The_wire_format_is_camel_case_with_lower_case_status_names()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workout = h.Workout();
        var orphan = h.Exercise(Guid.CreateVersion7());

        using var response = await client.PostAsJsonAsync("/sync/push", SyncHarness.Batch([workout], [orphan]));
        var text = await response.Content.ReadAsStringAsync();
        var pulled = await client.GetStringAsync("/sync/changes?since=0");

        // The app's generated types depend on exactly these names and values.
        Assert.Contains("\"status\":\"applied\"", text, StringComparison.Ordinal);
        Assert.Contains("\"status\":\"rejected\"", text, StringComparison.Ordinal);
        Assert.Contains("\"reason\":\"missing_parent\"", text, StringComparison.Ordinal);
        Assert.Contains("\"serverVersion\":1", text, StringComparison.Ordinal);
        Assert.Contains("\"workoutExercises\":[", text, StringComparison.Ordinal);
        Assert.Contains("\"hasMore\":false", pulled, StringComparison.Ordinal);
        Assert.Contains("\"cursor\":", pulled, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_empty_or_partial_push_is_fine()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());

        var empty = await SyncHarness.PushAsync(client, SyncHarness.Batch());
        var onlyPreferences = await SyncHarness.PushAsync(client, SyncHarness.Batch(preferences: [h.Preference()]));

        Assert.Empty(empty.Workouts);
        Assert.Empty(empty.Preferences);
        Assert.Equal(RowStatus.Applied, onlyPreferences.Preferences[0].Status);
        Assert.Empty(onlyPreferences.WorkoutSets);
    }

    // Conflicts: last writer wins

    [Fact]
    public async Task A_newer_edit_replaces_the_row_and_raises_the_version_and_change_number()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();
        await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "first")]));
        var seqBefore = (await h.StoredWorkoutsAsync()).Single().ChangeSeq;

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "second", updated: h.Now.AddMinutes(5))]));

        Assert.Equal(new RowResult(id, 2, RowStatus.Applied, null), result.Workouts[0]);
        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.Equal("second", stored.Notes);
        Assert.True(stored.ChangeSeq > seqBefore);
        Assert.Equal(h.Now.AddMinutes(5), stored.UpdatedAt);
    }

    [Fact]
    public async Task An_older_edit_loses_and_the_server_copy_stays()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();
        await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "newer", updated: h.Now.AddHours(1))]));

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "older", updated: h.Now)]));

        Assert.Equal(new RowResult(id, 1, RowStatus.Stale, null), result.Workouts[0]);
        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.Equal(("newer", 1L), (stored.Notes, stored.ServerVersion));
    }

    [Fact]
    public async Task The_same_time_with_different_content_loses_and_the_server_copy_stays()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();
        await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "from phone")]));

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "from tablet")]));

        Assert.Equal(RowStatus.Stale, result.Workouts[0].Status);
        Assert.Equal("from phone", Assert.Single(await h.StoredWorkoutsAsync()).Notes);
    }

    [Fact]
    public async Task Two_devices_editing_one_set_end_with_the_later_edit()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workout = h.Workout();
        var exercise = h.Exercise(workout.Id);
        var set = h.Set(exercise.Id, reps: 10);
        await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [exercise], [set]));

        // The tablet edited at 12:10 and pushed late. The phone edited at 12:05 and pushes after it.
        var tablet = await SyncHarness.PushAsync(client, SyncHarness.Batch(sets: [h.Set(exercise.Id, set.Id, reps: 12, updated: h.Now.AddMinutes(10))]));
        var phone = await SyncHarness.PushAsync(client, SyncHarness.Batch(sets: [h.Set(exercise.Id, set.Id, reps: 11, updated: h.Now.AddMinutes(5))]));

        Assert.Equal(RowStatus.Applied, tablet.WorkoutSets[0].Status);
        Assert.Equal(RowStatus.Stale, phone.WorkoutSets[0].Status);
        Assert.Equal(12, Assert.Single(await h.StoredSetsAsync()).Reps);
    }

    // Conflicts: deletes

    [Fact]
    public async Task A_delete_beats_a_later_edit_and_the_row_stays_deleted()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();
        await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "live")]));
        await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "live", updated: h.Now.AddMinutes(1), deleted: h.Now.AddMinutes(1))]));

        var edit = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "brought back", updated: h.Now.AddHours(1))]));

        Assert.Equal(RowStatus.Deleted, edit.Workouts[0].Status);
        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.NotNull(stored.DeletedAt);
        Assert.Equal("live", stored.Notes);
        Assert.Equal(2, stored.ServerVersion);
    }

    [Fact]
    public async Task A_delete_wins_even_when_its_time_is_older_than_the_servers_copy()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();
        await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "edited later", updated: h.Now.AddHours(2))]));

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "older delete", updated: h.Now, deleted: h.Now)]));

        Assert.Equal(RowStatus.Applied, result.Workouts[0].Status);
        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.NotNull(stored.DeletedAt);
        Assert.Equal("edited later", stored.Notes); // the newer content is kept
        Assert.Equal(h.Now.AddHours(2), stored.UpdatedAt);
    }

    [Fact]
    public async Task A_delete_of_a_row_the_server_never_saw_is_kept_so_a_late_edit_cannot_bring_it_back()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var id = Guid.CreateVersion7();

        var tombstone = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, deleted: h.Now)]));
        var lateEdit = await SyncHarness.PushAsync(client, SyncHarness.Batch([h.Workout(id, "edit", updated: h.Now.AddHours(1))]));

        Assert.Equal(RowStatus.Applied, tombstone.Workouts[0].Status);
        Assert.Equal(RowStatus.Deleted, lateEdit.Workouts[0].Status);
        Assert.NotNull(Assert.Single(await h.StoredWorkoutsAsync()).DeletedAt);
    }

    [Fact]
    public async Task Sending_a_delete_again_changes_nothing()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var set = h.Set(Guid.CreateVersion7());
        var workout = h.Workout();
        var exercise = h.Exercise(workout.Id);
        var deleted = h.Set(exercise.Id, set.Id, deleted: h.Now);
        await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [exercise], [deleted]));
        var seq = (await h.StoredSetsAsync()).Single().ChangeSeq;

        var again = await SyncHarness.PushAsync(client, SyncHarness.Batch(sets: [deleted]));

        Assert.Equal(RowStatus.Unchanged, again.WorkoutSets[0].Status);
        Assert.Equal(seq, (await h.StoredSetsAsync()).Single().ChangeSeq);
    }

    [Fact]
    public async Task A_preference_follows_the_same_rules_by_its_key()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        await SyncHarness.PushAsync(client, SyncHarness.Batch(preferences: [h.Preference("default_unit", "kg")]));

        var newer = await SyncHarness.PushAsync(client, SyncHarness.Batch(preferences: [h.Preference("default_unit", "lb", updated: h.Now.AddMinutes(1))]));
        var older = await SyncHarness.PushAsync(client, SyncHarness.Batch(preferences: [h.Preference("default_unit", "kg", updated: h.Now)]));

        Assert.Equal(new PreferenceResult("default_unit", 2, RowStatus.Applied, null), newer.Preferences[0]);
        Assert.Equal(RowStatus.Stale, older.Preferences[0].Status);
        Assert.Equal("lb", Assert.Single(await h.StoredPreferencesAsync()).Value);
    }

    // Offline for days

    [Fact]
    public async Task Rows_written_days_ago_are_accepted_with_their_original_times()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var written = h.Now - (3 * Day);
        var workout = h.Workout(created: written, updated: written + TimeSpan.FromMinutes(50));
        var exercise = h.Exercise(workout.Id, updated: written + TimeSpan.FromMinutes(10));
        var set = h.Set(exercise.Id, updated: written + TimeSpan.FromMinutes(12));

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [exercise], [set]));

        Assert.Equal(RowStatus.Applied, result.Workouts[0].Status);
        var stored = Assert.Single(await h.StoredWorkoutsAsync());
        Assert.Equal((written, written + TimeSpan.FromMinutes(50)), (stored.CreatedAt, stored.UpdatedAt));
        Assert.Equal(written + TimeSpan.FromMinutes(12), Assert.Single(await h.StoredSetsAsync()).UpdatedAt);
    }

    [Fact]
    public async Task A_week_of_dirty_rows_in_several_batches_arrives_oldest_first_without_loss()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var ids = new List<Guid>();

        for (var day = 7; day >= 1; day--)
        {
            var workout = h.Workout(updated: h.Now - (day * Day));
            ids.Add(workout.Id);
            await SyncHarness.PushAsync(client, SyncHarness.Batch([workout], [h.Exercise(workout.Id, updated: h.Now - (day * Day))]));
        }

        var pulled = await SyncHarness.PullAllAsync(client);
        Assert.Equal(ids, pulled.Workouts.Select(w => w.Id));
        Assert.Equal(7, pulled.Exercises.Count);
    }

    [Fact]
    public async Task Times_far_ahead_of_the_server_clock_are_rejected_and_do_not_block_other_rows()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());
        var wrongClock = h.Workout(updated: h.Now.AddDays(30));
        var fine = h.Workout();

        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([wrongClock, fine]));

        Assert.Equal(new RowResult(wrongClock.Id, 0, RowStatus.Rejected, RejectionReasons.FutureTimestamp), result.Workouts[0]);
        Assert.Equal(RowStatus.Applied, result.Workouts[1].Status);
        Assert.Equal(fine.Id, Assert.Single(await h.StoredWorkoutsAsync()).Id);
    }

    [Fact]
    public async Task The_allowed_skew_is_24_hours_by_default()
    {
        using var h = await SyncHarness.CreateAsync(postgres);
        using var client = h.ClientFor(await h.NewUserAsync());

        var inside = h.Workout(updated: h.Now.AddHours(23).AddMinutes(59));
        var outside = h.Workout(updated: h.Now.AddHours(24).AddMinutes(1));
        var result = await SyncHarness.PushAsync(client, SyncHarness.Batch([inside, outside]));

        Assert.Equal(RowStatus.Applied, result.Workouts[0].Status);
        Assert.Equal(RowStatus.Rejected, result.Workouts[1].Status);
    }

    // Cut here. The rest of the file covers parents and children, bad values, the shape of the request and
    // authentication.
}
