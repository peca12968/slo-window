using System.Globalization;
using System.Text;
using System.Text.Json;

namespace AccessRollup;

internal static class Program
{
    private const long MaxDailyCount = 999_999_999_999; // SLO Window input limit

    public static int Main(string[] args)
    {
        if (args is ["--help"])
        {
            Console.WriteLine("access-rollup [FILE|-]   Read NDJSON and write daily SLO CSV to stdout.");
            return 0;
        }
        if (args.Length > 1)
        {
            Console.Error.WriteLine("Expected one input file, '-' or standard input.");
            return 2;
        }
        try
        {
            using var input = args.Length == 0 || args[0] == "-"
                ? Console.OpenStandardInput() : File.OpenRead(args[0]);
            using var reader = new StreamReader(input, new UTF8Encoding(false, true), false);
            var counts = Aggregate(reader);
            Console.WriteLine("date,requests,errors");
            foreach (var (date, day) in counts)
                Console.WriteLine(FormattableString.Invariant($"{date:yyyy-MM-dd},{day.Requests},{day.Errors}"));
            return 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or InvalidDataException or DecoderFallbackException)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }
    }

    private static SortedDictionary<DateOnly, (long Requests, long Errors)> Aggregate(TextReader input)
    {
        var counts = new SortedDictionary<DateOnly, (long Requests, long Errors)>();
        long number = 0;
        while (input.ReadLine() is { } line)
        {
            number++;
            if (number == 1) line = line.TrimStart('\uFEFF');
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var record = JsonDocument.Parse(line);
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
                var date = DateOnly.FromDateTime(instant.UtcDateTime);
                var day = counts.GetValueOrDefault(date);
                if (day.Requests >= MaxDailyCount || (day.Requests == 0 && counts.Count == 3660))
                    throw new FormatException("data exceeds SLO Window CSV limits");
                counts[date] = (day.Requests + 1, day.Errors + (code >= 500 ? 1 : 0));
            }
            catch (Exception ex) when (ex is FormatException or JsonException)
            {
                throw new InvalidDataException($"Line {number}: {ex.Message}", ex);
            }
        }
        if (counts.Count == 0) throw new InvalidDataException("Input contains no request records.");
        return counts;
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
