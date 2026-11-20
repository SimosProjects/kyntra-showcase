// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;

namespace Kyntra.Sync;

public static class SyncEndpoints
{
    public const string PushPolicy = "sync-push";

    public const string PullPolicy = "sync-pull";

    // 200 rows with a full set of notes is well under this. It stops a body that is not a sync batch.
    private const long MaxPushBodyBytes = 2 * 1024 * 1024;

    public static IEndpointRouteBuilder MapSyncRoutes(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/sync").WithTags("Sync").RequireAuthorization();

        group.MapPost("/push", PushAsync)
            .WithName("SyncPush")
            .RequireRateLimiting(PushPolicy)
            .WithMetadata(new RequestSizeLimitAttribute(MaxPushBodyBytes))
            .Produces<PushResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesValidationProblem();
        group.MapGet("/changes", ChangesAsync)
            .WithName("SyncChanges")
            .RequireRateLimiting(PullPolicy)
            .Produces<ChangesResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesValidationProblem();
        return endpoints;
    }

    private static async Task<IResult> PushAsync(
        PushRequest request,
        HttpContext http,
        ISyncService sync,
        IOptions<SyncOptions> options,
        CancellationToken cancellationToken)
    {
        if (CheckBatch(request, options.Value.MaxBatchRows) is { } problems)
        {
            return Results.ValidationProblem(problems);
        }

        return Results.Ok(await sync.PushAsync(UserId(http), request, cancellationToken));
    }

    private static async Task<IResult> ChangesAsync(
        HttpContext http,
        ISyncService sync,
        IOptions<SyncOptions> options,
        CancellationToken cancellationToken,
        long since = 0,
        int? limit = null)
    {
        var settings = options.Value;
        if (since < 0 || limit is < 1)
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["query"] = ["since must be 0 or more and limit must be 1 or more."],
            });
        }

        var page = Math.Min(limit ?? settings.DefaultPullLimit, settings.MaxPullLimit);
        return Results.Ok(await sync.ChangesAsync(UserId(http), since, page, cancellationToken));
    }

    // Structure only. The rows themselves are judged one by one, so one bad row never blocks the rest.
    private static Dictionary<string, string[]>? CheckBatch(PushRequest request, int maxRows)
    {
        var problems = new Dictionary<string, string[]>();

        var total = (request.Workouts?.Count ?? 0) + (request.WorkoutExercises?.Count ?? 0)
            + (request.WorkoutSets?.Count ?? 0) + (request.Preferences?.Count ?? 0)
            + (request.Plans?.Count ?? 0) + (request.PlanExercises?.Count ?? 0) + (request.CustomExercises?.Count ?? 0);
        if (total > maxRows)
        {
            problems["rows"] = [$"A push may carry at most {maxRows} rows."];
        }

        CheckList(problems, "workouts", request.Workouts, r => r.Id);
        CheckList(problems, "workoutExercises", request.WorkoutExercises, r => r.Id);
        CheckList(problems, "workoutSets", request.WorkoutSets, r => r.Id);
        CheckList(problems, "preferences", request.Preferences, r => r.Key);
        CheckList(problems, "plans", request.Plans, r => r.Id);
        CheckList(problems, "planExercises", request.PlanExercises, r => r.Id);
        CheckList(problems, "customExercises", request.CustomExercises, r => r.Id);
        return problems.Count == 0 ? null : problems;
    }

    private static void CheckList<TRow, TKey>(Dictionary<string, string[]> problems, string name, IReadOnlyList<TRow>? rows, Func<TRow, TKey> key)
        where TRow : class
    {
        if (rows is null)
        {
            return;
        }

        if (rows.Any(r => r is null))
        {
            problems[name] = ["A row may not be null."];
        }
        else if (rows.Select(key).Distinct().Count() != rows.Count)
        {
            problems[name] = ["A row may appear only once in a push."];
        }
    }

    // The authentication handler has checked the token. This is the only place a user id comes from.
    private static Guid UserId(HttpContext http) =>
        Guid.TryParse(http.User.FindFirstValue("sub"), out var id)
            ? id
            : throw new InvalidOperationException("An authenticated request has no user id.");
}
