using System.Globalization;
using System.Text.Json;

namespace AccessRollup;

internal sealed class LatencyHistogram
{
    private readonly SortedDictionary<string, (long[] Bounds, long[] Counts)> shards = new(StringComparer.Ordinal);
    private readonly DateOnly day;

    public LatencyHistogram(string path)
    {
        using var input = File.OpenRead(path);
        using var config = JsonDocument.Parse(input, new JsonDocumentOptions { AllowDuplicateProperties = false });
        var root = config.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("utc_day", out var date) ||
            date.ValueKind != JsonValueKind.String ||
            !DateOnly.TryParseExact(date.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out day) ||
            !root.TryGetProperty("shards", out var sets) || sets.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Expected utc_day (YYYY-MM-DD) and shards in histogram config.");
        foreach (var set in sets.EnumerateObject())
        {
            if (string.IsNullOrWhiteSpace(set.Name) || set.Value.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("Expected a named shard with a list of boundaries.");
            var bounds = new List<long>();
            foreach (var value in set.Value.EnumerateArray())
            {
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var ms) ||
                    ms < 0 || (bounds.Count > 0 && ms <= bounds[^1]))
                    throw new InvalidDataException($"Invalid millisecond boundary in shard {set.Name}.");
                bounds.Add(ms);
            }
            shards.Add(set.Name, (bounds.ToArray(), new long[bounds.Count + 1]));
        }
        if (shards.Count == 0) throw new InvalidDataException("Configure at least one shard.");
    }

    public (string Shard, long Milliseconds) Read(JsonElement root, DateTimeOffset instant)
    {
        if (DateOnly.FromDateTime(instant.UtcDateTime) != day)
            throw new FormatException("timestamp outside the configured UTC day");
        if (!root.TryGetProperty("shard", out var name) || name.ValueKind != JsonValueKind.String ||
            name.GetString() is not string shard || !shards.ContainsKey(shard))
            throw new FormatException("expected a configured shard");
        if (!root.TryGetProperty("duration_ms", out var value) || value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt64(out var ms) || ms < 0)
            throw new FormatException("expected nonnegative integer duration_ms");
        return (shard, ms);
    }

    public void Add((string Shard, long Milliseconds) sample)
    {
        var (bounds, counts) = shards[sample.Shard];
        int index = Array.BinarySearch(bounds, sample.Milliseconds);
        checked { counts[index < 0 ? ~index : index]++; }
    }

    public void Write(TextWriter output)
    {
        output.WriteLine("shard,le_ms,cumulative_count");
        foreach (var (shard, buckets) in shards)
        {
            string quoted = "\"" + shard.Replace("\"", "\"\"") + "\"";
            long total = 0;
            for (int i = 0; i < buckets.Counts.Length; i++)
            {
                total = checked(total + buckets.Counts[i]);
                string boundary = i == buckets.Bounds.Length ? "+Inf" : buckets.Bounds[i].ToString(CultureInfo.InvariantCulture);
                output.WriteLine(FormattableString.Invariant($"{quoted},{boundary},{total}"));
            }
        }
    }
}
