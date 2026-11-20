// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using Kyntra.Api.Tests.Infrastructure;
using Xunit.Abstractions;

namespace Kyntra.Api.Tests;

/// <summary>
/// A guard against one query per row. The number of commands a push or a pull runs must not
/// depend on how many rows it carries.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class SyncQueryCountTests(PostgresFixture postgres, ITestOutputHelper output)
{
    private static readonly Dictionary<string, string?> LogCommands = new()
    {
        ["Serilog:MinimumLevel:Override:Microsoft.EntityFrameworkCore.Database.Command"] = "Information",
    };

    // Measured at 17 for a push of new rows, 13 for a replay, 15 for edits and 8 for a pull. The storage limits
    // (security review F-6) add a fixed nine per push, whatever its size. About double as a margin, so a small change to
    // the transaction handling does not break the test. A query per row would be 200 or more.
    private const int PushCommandBudget = 32;
    private const int PullCommandBudget = 10;

    [Fact]
    public async Task A_full_push_a_full_replay_and_a_full_pull_run_a_fixed_number_of_commands()
    {
        using var h = await SyncHarness.CreateAsync(postgres, LogCommands);
        using var client = h.ClientFor(await h.NewUserAsync());
        var workouts = Enumerable.Range(0, 50).Select(_ => h.Workout()).ToList();
        var exercises = workouts.Select(w => h.Exercise(w.Id)).ToList();
        var sets = exercises.Select(e => h.Set(e.Id)).ToList();
        var preferences = Enumerable.Range(0, 50).Select(i => h.Preference($"key-{i}")).ToList();
        var batch = SyncHarness.Batch(workouts, exercises, sets, preferences);

        var afterSetup = Commands(h);
        await SyncHarness.PushAsync(client, batch);
        var firstPush = Commands(h) - afterSetup;

        var beforeReplay = Commands(h);
        await SyncHarness.PushAsync(client, batch);
        var replay = Commands(h) - beforeReplay;

        // Every row changes: 200 updates in one push.
        var edited = SyncHarness.Batch(
            workouts.Select(w => w with { Notes = "edited", UpdatedAt = h.Now.AddMinutes(1) }),
            exercises.Select(e => e with { Position = 1, UpdatedAt = h.Now.AddMinutes(1) }),
            sets.Select(s => s with { Reps = 8, UpdatedAt = h.Now.AddMinutes(1) }),
            preferences.Select(p => p with { Value = "lb", UpdatedAt = h.Now.AddMinutes(1) }));
        var beforeEdit = Commands(h);
        await SyncHarness.PushAsync(client, edited);
        var editPush = Commands(h) - beforeEdit;

        var beforePull = Commands(h);
        var page = await SyncHarness.PullAsync(client, 0, limit: 500);
        var pull = Commands(h) - beforePull;

        output.WriteLine($"commands: new push {firstPush}, replay {replay}, edit push {editPush}, pull {pull}");
        Assert.Equal(200, page.Workouts.Count + page.WorkoutExercises.Count + page.WorkoutSets.Count + page.Preferences.Count);
        Assert.True(firstPush <= PushCommandBudget, $"A 200 row push of new rows ran {firstPush} commands.");
        Assert.True(replay <= PushCommandBudget, $"A 200 row replay ran {replay} commands.");
        Assert.True(editPush <= PushCommandBudget, $"A 200 row push of edits ran {editPush} commands.");
        Assert.True(pull <= PullCommandBudget, $"A pull of 200 rows ran {pull} commands.");
    }

    private static int Commands(SyncHarness h) =>
        h.Host.Logs.Entries.Count(e => e.Contains("Executed DbCommand", StringComparison.Ordinal));
}
