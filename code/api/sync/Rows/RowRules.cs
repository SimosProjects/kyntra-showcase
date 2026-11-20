// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
namespace Kyntra.Sync.Rows;

/// <summary>Normalization and checks shared by every table.</summary>
internal static class RowRules
{
    public const int MaxTimeZoneLength = 64;
    public const int MaxNotesLength = 4000;
    public const int MaxExerciseIdLength = 100;
    public const int MaxPreferenceKeyLength = 100;
    public const int MaxPreferenceValueLength = 1000;
    public const int MaxPosition = 100_000;
    public const int MaxCustomNameLength = 60;
    public const int MaxKindIdLength = 80;

    /// <summary>The muscle groups of the exercise catalog.</summary>
    public static readonly string[] MuscleGroups =
    [
        "chest", "lats", "upper_back", "lower_back", "traps", "shoulders", "biceps", "triceps", "forearms", "quadriceps", "hamstrings",
        "glutes", "calves", "abs", "obliques", "adductors", "abductors", "hip_flexors", "full_body", "cardio",
    ];

    // The column sizes in the schema: numeric(7,3), numeric(9,4), numeric(12,2), numeric(4,2).
    public const decimal MaxWeightValue = 9999.999m;
    public const decimal MaxWeightKg = 99999.9999m;
    public const decimal MaxDistance = 9_999_999_999.99m;
    public const decimal MaxRpe = 10m;
    public const decimal MaxDistanceValue = 999_999.999m;
    public const int MaxTargetReps = 100;
    public const int MaxTargetDurationSeconds = 86_400;
    public const decimal MaxTargetDistanceM = 1_000_000m;

    public static readonly string[] LogTypes = ["weight_reps", "reps", "duration", "distance_duration"];

    /// <summary>
    /// UTC, cut to the microsecond PostgreSQL keeps. A replayed row then compares equal to the
    /// stored one instead of differing by a few ticks.
    /// </summary>
    public static DateTimeOffset Time(DateTimeOffset value) =>
        new(value.UtcTicks - (value.UtcTicks % 10), TimeSpan.Zero);

    public static DateTimeOffset? Time(DateTimeOffset? value) => value is null ? null : Time(value.Value);

    public static decimal? Round(decimal? value, int places) =>
        value is null ? null : Math.Round(value.Value, places, MidpointRounding.AwayFromZero);

    public static bool HasAtMostPlaces(decimal value, int places) => Math.Round(value, places) == value;

    /// <summary>
    /// A one line value: no control characters at all. PostgreSQL cannot store a NUL in text, so one would fail the
    /// whole batch instead of its row.
    /// </summary>
    public static bool IsLine(string? value) => value is null || !value.Any(char.IsControl);

    /// <summary>Free text such as notes: new lines and tabs are fine, other control characters are not.</summary>
    public static bool IsText(string? value) => value is null || !value.Any(c => char.IsControl(c) && c is not '\n' and not '\t');

    /// <summary>The checks every row has: times that are not further ahead than the cap.</summary>
    public static string? CheckTimes(DateTimeOffset latest, DateTimeOffset created, DateTimeOffset updated, DateTimeOffset? deleted) =>
        created > latest || updated > latest || deleted > latest ? RejectionReasons.FutureTimestamp : null;
}
