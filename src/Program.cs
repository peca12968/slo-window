using System.Globalization;
using System.Text;
using System.Text.Json;

namespace AccessRollup;

internal static class Program
{
    private const long MaxDailyCount = 999_999_999_999; // SLO Window input limit

    private readonly record struct ObservedRequest(DateTimeOffset Instant, int Status,
        (string Shard, long Milliseconds)? Latency, string Source, long Line);

    public static int Main(string[] args)
    {
        if (args is ["--help"])
        {
            Console.WriteLine("access-rollup [--dedupe] [FILE|- ...]   Read NDJSON and write daily SLO CSV to stdout.");
            Console.WriteLine("--dedupe requires request_id on every record and rejects conflicting observations.");
            Console.WriteLine("access-rollup [--dedupe] --histogram CONFIG [FILE|- ...]   Write cumulative latency buckets.");
            return 0;
        }
        bool dedupe = args.Length > 0 && args[0] == "--dedupe";
        string[] sources = dedupe ? args[1..] : args;
        string? config = null;
        if (sources.Length > 0 && sources[0] == "--histogram")
        {
            if (sources.Length < 2) { Console.Error.WriteLine("--histogram requires a config file."); return 2; }
            config = sources[1];
            sources = sources[2..];
        }
        if (sources.Length == 0) sources = ["-"];
        if (sources.Count(s => s == "-") > 1)
        {
            Console.Error.WriteLine("Standard input may be specified only once.");
            return 2;
        }
        try
        {
            var counts = new SortedDictionary<DateOnly, (long Requests, long Errors)>();
            var histogram = config is null ? null : new LatencyHistogram(config);
            Dictionary<string, ObservedRequest>? seen = dedupe ? new(StringComparer.Ordinal) : null;
            foreach (var source in sources)
            {
                using var input = source == "-" ? Console.OpenStandardInput() : File.OpenRead(source);
                using var reader = new StreamReader(input, new UTF8Encoding(false, true), false);
                try
                {
                    Aggregate(reader, source == "-" ? "<stdin>" : source, counts, seen, histogram);
                }
                catch (DecoderFallbackException ex)
                {
                    throw new InvalidDataException($"{source}: invalid UTF-8", ex);
                }
            }
            if (histogram is not null)
            {
                histogram.Write(Console.Out);
                return 0;
            }
            if (counts.Count == 0) throw new InvalidDataException("Input contains no request records.");
            Console.WriteLine("date,requests,errors");
            foreach (var (date, day) in counts)
                Console.WriteLine(FormattableString.Invariant($"{date:yyyy-MM-dd},{day.Requests},{day.Errors}"));
            return 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or InvalidDataException or ArgumentException or JsonException or OverflowException)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }
    }

    private static void Aggregate(TextReader input, string source,
                                  SortedDictionary<DateOnly, (long Requests, long Errors)> counts,
                                  Dictionary<string, ObservedRequest>? seen, LatencyHistogram? histogram)
    {
        long number = 0;
        var options = new JsonDocumentOptions { AllowDuplicateProperties = seen is null && histogram is null };
        while (input.ReadLine() is { } line)
        {
            number++;
            if (number == 1) line = line.TrimStart('\uFEFF');
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var record = JsonDocument.Parse(line, options);
                var root = record.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    !root.TryGetProperty("timestamp", out var timestamp) ||
                    !root.TryGetProperty("status", out var status))
                    throw new FormatException("expected an object with timestamp and status");
                if (timestamp.ValueKind != JsonValueKind.String ||
                    !TryReadInstant(timestamp.GetString()!, out var instant))
                    throw new FormatException("timestamp must include a date, time and explicit UTC offset");
                if (status.ValueKind != JsonValueKind.Number ||
                    !status.TryGetInt32(out var code) || code is < 100 or > 599)
                    throw new FormatException("status must be an integer between 100 and 599");
                var latency = histogram?.Read(root, instant);
                if (seen is not null && IsRepeat(root, seen, new(instant, code, latency, source, number)))
                    continue;
                if (latency is { } sample)
                {
                    histogram!.Add(sample);
                    continue;
                }
                var date = DateOnly.FromDateTime(instant.UtcDateTime);
                var day = counts.GetValueOrDefault(date);
                if (day.Requests >= MaxDailyCount || (day.Requests == 0 && counts.Count == 3660))
                    throw new FormatException("data exceeds SLO Window CSV limits");
                counts[date] = (day.Requests + 1, day.Errors + (code >= 500 ? 1 : 0));
            }
            catch (Exception ex) when (ex is FormatException or JsonException or InvalidOperationException)
            {
                throw new InvalidDataException($"{source}: Line {number}: {ex.Message}", ex);
            }
        }
    }

    private static bool IsRepeat(JsonElement root, Dictionary<string, ObservedRequest> seen, ObservedRequest record)
    {
        if (!root.TryGetProperty("request_id", out var field) || field.ValueKind != JsonValueKind.String ||
            field.GetString() is not { Length: >= 1 and <= 128 } id ||
            !id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or ':'))
            throw new FormatException("request_id must be 1 to 128 ASCII letters, digits or -_.:");
        if (seen.TryAdd(id, record)) return false;
        var previous = seen[id];
        if (previous.Instant != record.Instant || previous.Status != record.Status || previous.Latency != record.Latency)
            throw new FormatException($"conflicting request_id '{id}', first seen at {previous.Source}: Line {previous.Line}");
        return true;
    }

    private static bool TryReadInstant(string text, out DateTimeOffset instant)
    {
        // Require an explicit offset; an unqualified timestamp would depend on the machine's zone.
        if (text.EndsWith('Z')) text = text[..^1] + "+00:00";
        string[] formats = ["yyyy-MM-dd'T'HH:mm:sszzz", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz"];
        return DateTimeOffset.TryParseExact(text, formats, CultureInfo.InvariantCulture,
                                            DateTimeStyles.None, out instant);
    }
}
