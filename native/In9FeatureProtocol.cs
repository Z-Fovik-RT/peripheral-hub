using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace PeripheralHub.Analysis
{
    // Stable pure-code surface: info query/parser, polling frame, and a local PSF parser.
    // No HID handles, Win32 imports, filesystem access, input collection, or transmissions.
    // Target executable SHA256: 8DB0F8B4BBF818F299B6C7131E4B4B94C9168846AEB9FD65347866D11BC502BC.
    public static class In9FeatureProtocol
    {
        public const int ReportLength = 33;
        public const byte ReportId = 0x0C;

        public static byte[] BuildInfoQuery(byte sequence, byte route = 1)
        {
            if (route > 1) throw new ArgumentOutOfRangeException(nameof(route));
            var frame = new byte[ReportLength];
            frame[0] = ReportId; frame[1] = route; frame[2] = 0x20; frame[4] = sequence;
            return frame;
        }
        public static byte[] BuildGetFeatureBuffer()
        {
            var frame = Enumerable.Repeat((byte)0xFF, ReportLength).ToArray();
            frame[0] = ReportId;
            return frame;
        }
        public static In9Info ParseInfo(byte[] frame, byte? expectedSequence = null)
        {
            if (frame == null || frame.Length != ReportLength) throw new ArgumentException("Expected 33 bytes including report ID.");
            if (frame[0] != ReportId || frame[1] > 1 || frame[2] != 0x20 || frame[3] != 0)
                throw new ArgumentException("Not an IN9 Feature info response.");
            if (expectedSequence.HasValue && frame[4] != expectedSequence.Value)
                throw new ArgumentException("Response sequence mismatch.");
            if (frame[5] != 1 || frame[6] < 16 || frame[6] > 26)
                throw new ArgumentException("Missing or unsupported info payload.");
            if (Encoding.ASCII.GetString(frame, 8, 4) != "M909")
                throw new ArgumentException("Unexpected device family marker.");
            if (frame[18] > 100) throw new ArgumentException("Invalid battery percentage.");
            if (frame[19] > 2) throw new ArgumentException("Unknown charge status.");
            return new In9Info {
                Sequence = frame[4], Route = frame[1], PayloadLength = frame[6], Family = "M909",
                SensorCode = frame[15], SensorName = SensorName(frame[15]), BatteryPercent = frame[18],
                ChargeStatusRaw = frame[19], IsCharging = frame[19] == 1, IsChargeComplete = frame[19] == 2,
                OfficialDisplayBatteryPercent = frame[19] == 2 ? 100 : frame[18],
                ActivityFlagRaw = frame[21],
                RawHex = BitConverter.ToString(frame).Replace("-", " ")
            };
        }
        private static string SensorName(byte value)
        {
            switch (value) {
                case 0x04: return "3104"; case 0x25: return "3325"; case 0x27: return "3327";
                case 0x12: return "3212"; case 0x35: return "3335"; case 0x60: return "3360";
                case 0x70: return "3370"; case 0x89: return "3389"; case 0x95: return "3395";
                case 0x99: return "3399"; default: return "unknown-0x" + value.ToString("X2");
            }
        }
        // Locally captured for 500 Hz; remaining codes follow the same official switch.
        public static byte[] BuildPollingRate(byte sequence, int hz)
        {
            var frame = new byte[ReportLength];
            frame[0] = ReportId; frame[1] = 1; frame[2] = 7; frame[4] = sequence;
            frame[5] = 1; frame[6] = 1;
            switch (hz) {
                case 1000: frame[7] = 1; break; case 500: frame[7] = 2; break;
                case 250: frame[7] = 4; break; case 125: frame[7] = 8; break;
                default: throw new ArgumentOutOfRangeException(nameof(hz));
            }
            return frame;
        }
        public static int PollingRateFromCode(byte code)
        {
            switch (code) { case 1: return 1000; case 2: return 500; case 4: return 250; case 8: return 125; default: throw new ArgumentOutOfRangeException(nameof(code)); }
        }
        // Corrected local 3325 table: initializer VA40887B and display VA42E789 (x50).
        // PSF stores zero-based table indices; wire registers are index+1.
        // Reference/frozen analysis source remains unchanged for provenance.
        public static int[] Get3325DpiOptions()
        {
            var options = new List<int>();
            for (int dpi = 200; dpi <= 5000; dpi += 100) options.Add(dpi);
            options.AddRange(new[] {5500,6000,6400,7000,7500,8000,8500,9000,9500,10000});
            return options.ToArray();
        }
        public static ushort DpiTo3325Register(int dpi)
        {
            int index = Array.IndexOf(Get3325DpiOptions(), dpi);
            if (index < 0) throw new ArgumentOutOfRangeException(nameof(dpi));
            return (ushort)(index + 1);
        }
        public static int RegisterTo3325Dpi(ushort value)
        {
            var table = Get3325DpiOptions();
            if (value < 1 || value > table.Length) throw new ArgumentOutOfRangeException(nameof(value));
            return table[value - 1];
        }
        // Earlier draft writes were withdrawn. Compile-time and runtime freezes keep
        // incomplete transforms separate from the stable parser and polling surface.
        [Obsolete("Frozen: pending a local 0x05 trace, including current-index and fixed 18-byte payload.", true)]
        public static byte[] BuildDpi(byte sequence, IReadOnlyList<int> dpis, int currentIndex) { throw Frozen(); }
        [Obsolete("Frozen: PSF index semantics require a local trace.", true)]
        public static byte[] BuildDpiProfile(byte sequence, byte currentProfileValue, byte enabledMask, IReadOnlyList<int> dpis) { throw Frozen(); }
        [Obsolete("Frozen: fixed 24-byte color payload and channel order require a local trace.", true)]
        public static byte[] BuildDpiColors(byte sequence, IReadOnlyList<int> colorsRgb) { throw Frozen(); }
        [Obsolete("Frozen: mode-specific length, count, levels and color order require a local trace.", true)]
        public static byte[] BuildLighting(byte sequence, byte mode, byte brightness, byte speed, IReadOnlyList<int> rgb = null) { throw Frozen(); }
        [Obsolete("Frozen: profile key 3/4 swap and physical ordering require a local trace.", true)]
        public static byte[] BuildKey(byte sequence, int keyIndex, byte type, byte value1, byte value2) { throw Frozen(); }
        [Obsolete("Frozen: PSF macro storage is not the 3-byte wire action stream.", true)]
        public static IReadOnlyList<byte[]> BuildMacro(byte sequence, int keyIndex, byte[] actionStream) { throw Frozen(); }
        [Obsolete("Frozen: setting units and flag semantics require a local trace.", true)]
        public static byte[] BuildRawSetting(byte command, byte sequence, params byte[] payload) { throw Frozen(); }
        private static NotSupportedException Frozen() { return new NotSupportedException("Unvalidated write builder is frozen; see protocol-report.md."); }

        public static Dictionary<string, string> ParsePsfText(string text)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in In9SettingsParser.Entries(text)) {
                string key = entry.Key;
                if (result.ContainsKey(key)) {
                    int n = 2;
                    while (result.ContainsKey(key + "#" + n)) n++;
                    key += "#" + n;
                }
                result[key] = entry.Value;
            }
            return result;
        }
    }

    public sealed class In9Info
    {
        public byte Sequence { get; set; }
        public byte Route { get; set; }
        public byte PayloadLength { get; set; }
        public string Family { get; set; }
        public byte SensorCode { get; set; }
        public string SensorName { get; set; }
        public byte BatteryPercent { get; set; }
        public byte ChargeStatusRaw { get; set; }
        public bool IsCharging { get; set; }
        public bool IsChargeComplete { get; set; }
        public int OfficialDisplayBatteryPercent { get; set; }
        // Byte21 changes between 0 and 1 while queries continue succeeding. Do not
        // use it as a connection/online indicator; exact UI-state semantics are open.
        public byte ActivityFlagRaw { get; set; }
        public string RawHex { get; set; }
    }

    public sealed class In9Settings
    {
        public string SourceKind { get { return "official-local-profile-snapshot"; } }
        public bool IsHardwareReadback { get { return false; } }
        public string SourceLabel { get; set; }
        public string ProfileName { get; set; }
        public Dictionary<string, string> Raw { get; set; }
        public Dictionary<string, int?> HostMouseSettings { get; set; }
        public string[] LinkedGameFiles { get; set; }
        public ushort?[] DpiProfileValuesRaw { get; set; }
        public byte? CurrentDpiStageRaw { get; set; }
        // No guessed DPI values/current index: these require PSF-loader correlation.
        public byte? DpiEnabledMask { get; set; }
        public int?[] DpiIndicatorColorsTextRgb { get; set; }
        public byte[] PollingRateValueRaw { get; set; }
        public string PollingRateName { get; set; }
        public int? PollingRateHz { get; set; }
        public byte? AngleSnapRaw { get; set; }
        public byte? LiftDetectionRaw { get; set; }
        public In9LightingSetting[] Lighting { get; set; }
        public In9KeySetting[] Keys { get; set; }
        // Legacy field retained as raw saved data, not interpreted as the current sleep setting.
        public int? SleepTimeRaw { get; set; }
        public int? PowerDownTimeRaw { get; set; }
        public int? KeyDebounceRaw { get; set; }
        public bool? MoveClosesLight { get; set; }
        public bool? MotionWakeup { get; set; }
        public string[] Notes { get; set; }
    }
    public sealed class In9LightingSetting
    {
        public int Zone { get; set; }
        public string Name { get; set; }
        public byte[] ModeValueRaw { get; set; }
        public bool? Enabled { get; set; }
        public byte[] SpeedIndicesRaw { get; set; }
        public byte[] BrightnessIndicesRaw { get; set; }
        public byte[] DirectionsRaw { get; set; }
        public byte[][] ColorSelectionRaw { get; set; }
        public int[][] ColorsTextRgb { get; set; }
    }
    public sealed class In9KeySetting
    {
        public int ProfileIndex { get; set; }
        public string Name { get; set; }
        public byte[] ValueRaw { get; set; }
        public string MacroName { get; set; }
        public int? MacroActionCount { get; set; }
        public byte[] MacroStoredBytes { get; set; }
        // Stored AllAction contains padded records. Do not pass it to a wire uploader.
    }
    public static class In9SettingsParser
    {
        internal static IEnumerable<KeyValuePair<string, string>> Entries(string text)
        {
            if (text == null) throw new ArgumentNullException(nameof(text));
            string section = "";
            foreach (string raw in text.Split(new[] {'\r','\n'}, StringSplitOptions.RemoveEmptyEntries)) {
                string line = raw.Trim().TrimStart('\uFEFF');
                if (line.Length == 0 || line.StartsWith(";") || line.StartsWith("#")) continue;
                if (line.StartsWith("[") && line.EndsWith("]")) { section = line.Substring(1, line.Length - 2); continue; }
                if (!string.Equals(section, "Setting", StringComparison.OrdinalIgnoreCase)) continue;
                int eq = line.IndexOf('=');
                if (eq > 0) yield return new KeyValuePair<string, string>(line.Substring(0, eq).Trim(), line.Substring(eq + 1).Trim());
            }
        }
        public static In9Settings ParseLocalPsf(string text, string sourceLabel = "caller-supplied PSF text")
        {
            var entries = Entries(text).ToList();
            var raw = In9FeatureProtocol.ParsePsfText(text);
            var notes = new List<string> {
                "Values are saved local settings, not a device readback.",
                "DPI profile indices/current-stage raw values are preserved without an unproven DPI conversion.",
                "PSF polling value is a UI index tuple; it is not the wire rate code.",
                "PSF AllAction is stored macro data, not the 3-byte wire action stream."
            };
            string[] hostNames = {"DoubleClickSpeed","PointerSpeed","AccelerationEnable","ScrollWheelSpeed","ScrollWheelPageEnable","TiltSpeed","Sensitivity_X","Sensitivity_Y","XYSynchronous","X_DPI","Y_DPI","RightLeftHandMode"};
            var keys = new SortedDictionary<int, In9KeySetting>();
            In9KeySetting active = null;
            foreach (var e in entries) {
                int index;
                if (KeyIndex(e.Key, "Key", "Name", out index)) {
                    if (!keys.TryGetValue(index, out active)) { active = new In9KeySetting { ProfileIndex = index }; keys[index] = active; }
                    active.Name = e.Value;
                } else if (KeyIndex(e.Key, "Key", "Value", out index)) {
                    if (!keys.TryGetValue(index, out active)) { active = new In9KeySetting { ProfileIndex = index }; keys[index] = active; }
                    active.ValueRaw = HexBytes(e.Value);
                } else if (KeyIndex(e.Key, "MacroKey", "Name", out index)) {
                    if (!keys.TryGetValue(index, out active)) { active = new In9KeySetting { ProfileIndex = index }; keys[index] = active; }
                    active.MacroName = e.Value;
                } else if (active != null && e.Key.Equals("MacroActionNum", StringComparison.OrdinalIgnoreCase)) active.MacroActionCount = Decimal(e.Value);
                else if (active != null && e.Key.Equals("AllAction", StringComparison.OrdinalIgnoreCase)) active.MacroStoredBytes = HexBytes(e.Value);
            }
            byte[] rate = HexBytes(Get(raw, "PollingRateValue"));
            int? hz = null;
            if (rate != null && rate.Length == 3 && rate[0] < 4 && rate[1] == 0 && rate[2] == 0)
                hz = new[] {125,250,500,1000}[rate[0]];
            string rateName = Get(raw, "PollingRateName");
            int namedHz;
            if (rateName != null && int.TryParse(rateName.ToUpperInvariant().Replace("HZ", "").Trim(), out namedHz) && hz.HasValue && namedHz != hz)
                notes.Add("PollingRateName disagrees with the stored index; preserve both for review.");
            string sleep = Get(raw, "SleepTime");
            string powerDown = Get(raw, "PowerDownTime");
            string keyDebounce = Get(raw, "KeyDebounce");
            if (powerDown == null) notes.Add("PowerDownTime is absent; no sleep duration is inferred.");
            if (keyDebounce == null) notes.Add("KeyDebounce is absent; no debounce value is inferred.");
            if (sleep != null) notes.Add("Legacy SleepTime is preserved as raw data, not substituted for PowerDownTime.");
            if (!raw.ContainsKey("MoveLightingOnOffMode")) notes.Add("MoveLightingOnOffMode is absent.");
            if (!raw.ContainsKey("MotionWakeup")) notes.Add("MotionWakeup is absent.");
            return new In9Settings {
                SourceLabel = sourceLabel, ProfileName = Get(raw, "ProfileName"), Raw = raw,
                HostMouseSettings = hostNames.ToDictionary(x => x, x => Decimal(Get(raw,x))),
                LinkedGameFiles = Enumerable.Range(0,3).Select(i => Get(raw,"GameFile"+i)).ToArray(),
                DpiProfileValuesRaw = Enumerable.Range(1,8).Select(i => WordHex(Get(raw,"XYSetting"+i+"Value"))).ToArray(),
                CurrentDpiStageRaw = ByteHex(Get(raw,"CurrentDPILevelValue")), DpiEnabledMask = ByteHex(Get(raw,"DPIOffOnFlagValue")),
                DpiIndicatorColorsTextRgb = Enumerable.Range(0,8).Select(i => Color(Get(raw,"DPILevelIndication"+i+"Valuer"))).ToArray(),
                PollingRateValueRaw = rate, PollingRateName = rateName, PollingRateHz = hz,
                AngleSnapRaw = ByteHex(Get(raw,"AngleSnapValue")), LiftDetectionRaw = ByteHex(Get(raw,"LiftDetectionValue")),
                Lighting = new[] {ParseLight(raw,1),ParseLight(raw,2)}, Keys = keys.Values.ToArray(),
                SleepTimeRaw = Decimal(sleep), PowerDownTimeRaw = Decimal(powerDown), KeyDebounceRaw = Decimal(keyDebounce), MoveClosesLight = BoolDecimal(Get(raw,"MoveLightingOnOffMode")), MotionWakeup = BoolDecimal(Get(raw,"MotionWakeup")),
                Notes = notes.ToArray()
            };
        }
        private static In9LightingSetting ParseLight(Dictionary<string,string> raw, int zone)
        {
            string p = "Lighting"+zone;
            byte? enabled = ByteHex(Get(raw,p+"OffOn"));
            return new In9LightingSetting {
                Zone=zone, Name=Get(raw,p+"Name"), ModeValueRaw=HexBytes(Get(raw,p+"ModeValue")), Enabled=enabled.HasValue ? (bool?)(enabled.Value != 0) : null,
                SpeedIndicesRaw=PipeBytes(Get(raw,p+"Speed")), BrightnessIndicesRaw=PipeBytes(Get(raw,p+"Brightness")), DirectionsRaw=PipeBytes(Get(raw,p+"Direction")),
                ColorSelectionRaw=Rows(Get(raw,p+"ColorSelected")).Select(PipeBytes).ToArray(),
                ColorsTextRgb=Rows(Get(raw,p+"FixedColor")).Select(row => row.Split('|').Select(c => Color(c) ?? throw new FormatException("Invalid color.")).ToArray()).ToArray()
            };
        }
        private static bool KeyIndex(string key, string prefix, string suffix, out int index)
        {
            index = -1;
            return key.StartsWith(prefix,StringComparison.OrdinalIgnoreCase) && key.EndsWith(suffix,StringComparison.OrdinalIgnoreCase)
                && key.Length > prefix.Length + suffix.Length && int.TryParse(key.Substring(prefix.Length,key.Length-prefix.Length-suffix.Length),out index) && index>=0;
        }
        private static string Get(Dictionary<string,string> d,string k) { string v; return d.TryGetValue(k,out v) ? v : null; }
        private static int? Decimal(string x) { if(x==null)return null;return int.Parse(x,NumberStyles.Integer,CultureInfo.InvariantCulture); }
        private static bool? BoolDecimal(string x) { int? n=Decimal(x);if(!n.HasValue)return null;if(n!=0&&n!=1)throw new FormatException("Invalid boolean.");return n==1; }
        private static byte? ByteHex(string x) { if(x==null)return null;return byte.Parse(x,NumberStyles.HexNumber,CultureInfo.InvariantCulture); }
        private static ushort? WordHex(string x) { if(x==null)return null;return ushort.Parse(x,NumberStyles.HexNumber,CultureInfo.InvariantCulture); }
        private static int? Color(string x) { if(x==null)return null;if(x.Length!=6)throw new FormatException("Expected six hex color digits.");return int.Parse(x,NumberStyles.HexNumber,CultureInfo.InvariantCulture); }
        private static byte[] HexBytes(string x)
        {
            if(x==null)return null;
            if(x.Length%2!=0)throw new FormatException("Odd number of hex digits.");
            var bytes=new byte[x.Length/2];
            for(int i=0;i<bytes.Length;i++)bytes[i]=byte.Parse(x.Substring(i*2,2),NumberStyles.HexNumber,CultureInfo.InvariantCulture);
            return bytes;
        }
        private static byte[] PipeBytes(string x) { return x==null ? null : x.Split('|').Select(v=>ByteHex(v).Value).ToArray(); }
        private static string[] Rows(string x) { return x==null ? new string[0] : x.Split(new[]{';'},StringSplitOptions.RemoveEmptyEntries); }
    }
}
