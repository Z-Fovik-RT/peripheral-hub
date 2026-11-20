using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace PeripheralHub
{
    // Local drafts only. Length/marker checks do not establish a same-device recovery baseline.
    public static class AulaDraftCodec
    {
        private static readonly int[] MatrixIndices = {
            0,12,18,24,30,36,42,48,54,60,66,72,78,1,7,13,19,25,31,37,43,49,55,61,67,73,79,84,90,96,
            2,8,14,20,26,32,38,44,50,56,62,68,74,80,86,85,91,97,3,9,15,21,27,33,39,45,51,57,63,69,
            81,92,98,4,10,16,22,28,34,40,46,52,58,64,82,94,83,5,11,17,35,53,59,65,89,95,101
        };

        public sealed class Draft
        {
            public byte[] Data { get; internal set; }
            public string OriginalSha256 { get; internal set; }
            public string Sha256 { get; internal set; }
            public int[] ChangedOffsets { get; internal set; }
            public string BlockKind { get; internal set; }
            public int? Layer { get; internal set; }
            public int ActualLength { get { return Data.Length; } }
            public bool CompleteBlockCaptured { get { return Data.Length == 512 && BlockKind != "macro"; } }
            public bool WriteBaselineEligible { get { return false; } }
            public bool HardwareIO { get { return false; } }
        }

        public static int GetMatrixIndex(string keyId)
        {
            int number;
            if (keyId == null || keyId.Length < 2 || keyId[0] != 'K' ||
                !Int32.TryParse(keyId.Substring(1), out number) || number < 1 || number > MatrixIndices.Length ||
                keyId != "K" + number.ToString(System.Globalization.CultureInfo.InvariantCulture))
                throw new ArgumentException("Expected an exact F87 PRO physical key ID K1..K87.", nameof(keyId));
            return MatrixIndices[number - 1];
        }

        public static Draft PatchKeyboard(byte[] data, int layer, string keyId, int modifiers, int primaryUsage, int secondaryUsage)
        {
            RequireByte(modifiers, nameof(modifiers));
            RequireByte(primaryUsage, nameof(primaryUsage));
            RequireByte(secondaryUsage, nameof(secondaryUsage));
            return PatchMatrix(data, layer, keyId, AulaConfigurationCodec.EncodeKeyboardEntry((byte)modifiers, (byte)primaryUsage, (byte)secondaryUsage));
        }

        public static Draft PatchConsumer(byte[] data, int layer, string keyId, int consumerUsage)
        {
            if (consumerUsage < 0 || consumerUsage > 65535) throw new ArgumentOutOfRangeException(nameof(consumerUsage));
            return PatchMatrix(data, layer, keyId, AulaConfigurationCodec.EncodeConsumerEntry((ushort)consumerUsage));
        }

        public static Draft PatchMacroBinding(byte[] data, int layer, string keyId, int repeatMode, int repeatCount, int macroIndex)
        {
            if (repeatMode != 1 && repeatMode != 2 && repeatMode != 4) throw new ArgumentOutOfRangeException(nameof(repeatMode));
            if (repeatCount < 1 || repeatCount > 255 || (repeatMode != 1 && repeatCount != 1))
                throw new ArgumentOutOfRangeException(nameof(repeatCount), "Only counted mode 1 stores a configurable count; modes 2/4 store 1.");
            if (macroIndex < 0 || macroIndex > 99) throw new ArgumentOutOfRangeException(nameof(macroIndex));
            return PatchMatrix(data, layer, keyId, new byte[] { 3, (byte)repeatMode, (byte)repeatCount, (byte)macroIndex });
        }

        public static Draft PatchPaletteColor(byte[] data, int modeId, int colorIndex, int r, int g, int b)
        {
            RequirePalette(data);
            // Match the installed profile's visible palette-capable effects and the production read contract.
            if (modeId != 1 && modeId != 2 && modeId != 4 && modeId != 5 && modeId != 7 && modeId != 8 &&
                modeId != 10 && modeId != 11 && modeId != 12 && modeId != 13)
                throw new ArgumentOutOfRangeException(nameof(modeId), "This effect has no supported editable palette.");
            if (colorIndex < 0 || colorIndex > 6) throw new ArgumentOutOfRangeException(nameof(colorIndex));
            RequireByte(r, nameof(r)); RequireByte(g, nameof(g)); RequireByte(b, nameof(b));
            byte[] copy = (byte[])data.Clone();
            int offset = 21 * modeId + 3 * colorIndex;
            copy[offset] = (byte)r; copy[offset + 1] = (byte)g; copy[offset + 2] = (byte)b;
            return Result(data, copy, "palette", null);
        }

        public static byte[] BuildMacroRecord(string name, int[] eventClasses, bool[] flags80, int[] delayTicks, int[] codes)
        {
            if (String.IsNullOrWhiteSpace(name) || name.Length > 30 || name.IndexOf('\0') >= 0)
                throw new ArgumentException("Macro name must contain 1..30 UTF-16 code units and no NUL.", nameof(name));
            if (eventClasses == null || flags80 == null || delayTicks == null || codes == null ||
                eventClasses.Length != flags80.Length || eventClasses.Length != delayTicks.Length || eventClasses.Length != codes.Length)
                throw new ArgumentException("Macro event arrays must all have the same length.");
            byte[] encodedName = new UnicodeEncoding(false, false, true).GetBytes(name);
            int eventCount = eventClasses.Length;
            if (eventCount < 1 || eventCount > (4096 - 1 - encodedName.Length) / 4)
                throw new ArgumentOutOfRangeException(nameof(eventClasses), "Macro record exceeds the static 4096-byte capacity limit.");
            var result = new byte[1 + encodedName.Length + 4 * eventCount];
            result[0] = (byte)encodedName.Length;
            Buffer.BlockCopy(encodedName, 0, result, 1, encodedName.Length);
            for (int i = 0; i < eventCount; i++)
            {
                RequireByte(codes[i], nameof(codes));
                // Delays are explicit device ticks. No guessed milliseconds conversion is performed.
                byte[] encoded = AulaConfigurationCodec.EncodeMacroEvent(eventClasses[i], flags80[i], delayTicks[i], (byte)codes[i]);
                Buffer.BlockCopy(encoded, 0, result, 1 + encodedName.Length + 4 * i, 4);
            }
            return result;
        }

        // Produces only the used directory+records. It never adds an assumed device-memory tail.
        public static byte[] PackMacroRecords(byte[][] records)
        {
            if (records == null || records.Length < 1 || records.Length > 100) throw new ArgumentOutOfRangeException(nameof(records));
            int total = records.Length * 4;
            for (int i = 0; i < records.Length; i++)
            {
                AulaConfigurationCodec.ParseMacroRecord(records[i]);
                if (records[i].Length > 4096 || total > 4096 - records[i].Length)
                    throw new ArgumentException("Macro table exceeds the static 4096-byte capacity limit.", nameof(records));
                total += records[i].Length;
            }
            var table = new byte[total]; int offset = records.Length * 4;
            for (int i = 0; i < records.Length; i++)
            {
                table[i * 4] = (byte)offset; table[i * 4 + 1] = (byte)(offset >> 8);
                table[i * 4 + 2] = (byte)records[i].Length; table[i * 4 + 3] = (byte)(records[i].Length >> 8);
                Buffer.BlockCopy(records[i], 0, table, offset, records[i].Length);
                offset += records[i].Length;
            }
            return table;
        }

        public static Draft PatchMacroRecord(byte[] data, int count, int index, byte[] replacement)
        {
            if (data == null || data.Length > 4096) throw new ArgumentException("Expected an existing macro table of at most 4096 bytes.", nameof(data));
            var records = AulaConfigurationCodec.ParseMacroTable(data, count);
            if (index < 0 || index >= records.Length) throw new ArgumentOutOfRangeException(nameof(index));
            AulaConfigurationCodec.ParseMacroRecord(replacement);
            var record = records[index];
            if (replacement.Length != record.Length)
                throw new ArgumentException("Only equal-length replacement preserves unknown directory gaps and the opaque memory tail.", nameof(replacement));
            byte[] copy = (byte[])data.Clone();
            Buffer.BlockCopy(replacement, 0, copy, record.Offset, replacement.Length);
            return Result(data, copy, "macro", null);
        }

        private static Draft PatchMatrix(byte[] data, int layer, string keyId, byte[] entry)
        {
            if (layer < 0 || layer > 3) throw new ArgumentOutOfRangeException(nameof(layer));
            if (data != null && data.Length == 504) AulaReadModels.ParseMatrix504(data, layer);
            else if (data != null && data.Length == 512) AulaConfigurationCodec.ParseMatrix512(data, layer, true);
            else throw new ArgumentException("Expected exactly 504 captured wireless bytes or a complete 512-byte matrix; no padding is allowed.", nameof(data));
            int offset = GetMatrixIndex(keyId) * 4;
            byte[] copy = (byte[])data.Clone();
            Buffer.BlockCopy(entry, 0, copy, offset, 4);
            return Result(data, copy, "matrix", layer);
        }

        private static void RequirePalette(byte[] data)
        {
            if (data != null && data.Length == 490) AulaReadModels.ParsePalette490(data, 1);
            else if (data != null && data.Length == 512) AulaConfigurationCodec.ParsePalette512(data);
            else throw new ArgumentException("Expected exactly 490 captured wireless bytes or a complete 512-byte palette; no padding is allowed.", nameof(data));
        }

        private static void RequireByte(int value, string name)
        {
            if (value < 0 || value > 255) throw new ArgumentOutOfRangeException(name);
        }

        private static Draft Result(byte[] original, byte[] draft, string kind, int? layer)
        {
            var changes = new List<int>();
            for (int i = 0; i < original.Length; i++) if (original[i] != draft[i]) changes.Add(i);
            return new Draft { Data = draft, OriginalSha256 = Hash(original), Sha256 = Hash(draft),
                ChangedOffsets = changes.ToArray(), BlockKind = kind, Layer = layer };
        }

        private static string Hash(byte[] data)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-", "");
        }
    }
}
