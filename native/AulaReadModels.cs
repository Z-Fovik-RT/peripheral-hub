using System;
using System.Collections.Generic;

namespace PeripheralHub
{
    /// <summary>Pure models for the current wireless captures. Caller owns validated framing.
    /// No device I/O, encoders, padding, restoration baseline, or vendor execution.</summary>
    public static class AulaReadModels
    {
        public sealed class IdentitySnapshot
        {
            public byte[] Raw { get; internal set; }
            public byte[] Psd { get; internal set; }
            public byte[] Extra { get; internal set; }
            public string RawHex { get; internal set; }
            public string PsdHex { get; internal set; }
            public string ExtraHex { get; internal set; }
            public bool MatchesPsd { get; internal set; }
            public bool MatchesExpectedPsd { get { return MatchesPsd; } }
            public int ActualLength { get { return Raw.Length; } }
        }
        public sealed class MatrixEntry
        {
            public int Index { get; internal set; }
            public int Offset { get; internal set; }
            public byte[] Raw { get; internal set; }
            public string RawHex { get; internal set; }
            public uint RawValue { get; internal set; }
            public string Kind { get; internal set; }
            public int? Modifiers { get; internal set; }
            public int? PrimaryHidUsage { get; internal set; }
            public int? SecondaryHidUsage { get; internal set; }
            public int? ConsumerUsage { get; internal set; }
        }
        public sealed class MatrixSnapshot
        {
            public byte[] Raw { get; internal set; }
            public int Layer { get; internal set; }
            public MatrixEntry[] Entries { get; internal set; }
            public int ActualLength { get { return Raw.Length; } }
            public int EntryCount { get { return Entries.Length; } }
            public bool Schema512Complete { get { return false; } }
            public bool BlockMarkerCaptured { get { return false; } }
            public bool WriteBaselineEligible { get { return false; } }
        }
        public sealed class RgbColor
        {
            public int R { get; internal set; }
            public int G { get; internal set; }
            public int B { get; internal set; }
            public string Hex { get; internal set; }
        }
        public sealed class PaletteSnapshot
        {
            public byte[] Raw { get; internal set; }
            public int ModeId { get; internal set; }
            public int ModeTableIndex { get; internal set; }
            public int Offset { get; internal set; }
            public RgbColor[] Colors { get; internal set; }
            public byte[] OpaqueTail { get; internal set; }
            public int ActualLength { get { return Raw.Length; } }
            public bool Schema512Complete { get { return false; } }
            public bool BlockMarkerCaptured { get { return false; } }
            public bool WriteBaselineEligible { get { return false; } }
        }

        public static IdentitySnapshot ParseIdentity10(byte[] data)
        {
            return ParseIdentity10(data, new byte[] { 3, 0, 0, 0, 1, 0x0B });
        }
        public static IdentitySnapshot ParseIdentity10(byte[] data, byte[] expectedPsd)
        {
            byte[] raw = RequireCopy(data, 10);
            if (expectedPsd == null || expectedPsd.Length != 6)
                throw new ArgumentException("Expected PSD must contain exactly six bytes.", nameof(expectedPsd));
            byte[] psd = Slice(raw, 0, 6), extra = Slice(raw, 6, 4);
            bool same = true;
            for (int i = 0; i < 6; i++) if (psd[i] != expectedPsd[i]) same = false;
            return new IdentitySnapshot { Raw = raw, Psd = psd, Extra = extra,
                RawHex = Hex(raw), PsdHex = Hex(psd), ExtraHex = Hex(extra), MatchesPsd = same };
        }
        public static MatrixSnapshot ParseMatrix504(byte[] data)
        {
            return ParseMatrix504(data, 0);
        }
        public static MatrixSnapshot ParseMatrix504(byte[] data, int layer)
        {
            if (layer < 0 || layer > 3) throw new ArgumentOutOfRangeException(nameof(layer));
            byte[] raw = RequireCopy(data, 504);
            var entries = new MatrixEntry[126];
            for (int i = 0; i < entries.Length; i++)
            {
                int o = i * 4;
                byte a = raw[o], b = raw[o + 1], c = raw[o + 2], d = raw[o + 3];
                byte[] record = new byte[] { a, b, c, d };
                var entry = new MatrixEntry { Index = i, Offset = o, Raw = record, RawHex = Hex(record),
                    RawValue = (uint)(a | (b << 8) | (c << 16) | (d << 24)), Kind = "unknown" };
                // Only fields established by the G5 codec are decoded here.
                // Special/macro/mouse/firmware actions remain unknown with raw bytes.
                if (a == 0)
                {
                    entry.Kind = b == 0 && c == 0 && d == 0 ? "empty-or-disabled" : "keyboard";
                    entry.Modifiers = b; entry.SecondaryHidUsage = c; entry.PrimaryHidUsage = d;
                }
                else if (a == 2)
                {
                    entry.Kind = "consumer"; entry.ConsumerUsage = (c << 8) | d;
                }
                entries[i] = entry;
            }
            return new MatrixSnapshot { Raw = raw, Layer = layer, Entries = entries };
        }
        public static PaletteSnapshot ParsePalette490(byte[] data, int modeId)
        {
            int index;
            if (modeId >= 1 && modeId <= 18) index = modeId - 1;
            else if (modeId == 21) index = 18;
            else if (modeId == 0) index = 19;
            else throw new ArgumentOutOfRangeException(nameof(modeId), "Supported hardware mode IDs:0,1..18,21.");
            byte[] raw = RequireCopy(data, 490);
            int offset = 21 * (index + 1);
            var colors = new RgbColor[7];
            for (int i = 0; i < colors.Length; i++)
            {
                int o = offset + i * 3;
                colors[i] = new RgbColor { R = raw[o], G = raw[o + 1], B = raw[o + 2],
                    Hex = "#" + raw[o].ToString("X2") + raw[o + 1].ToString("X2") + raw[o + 2].ToString("X2") };
            }
            return new PaletteSnapshot { Raw = raw, ModeId = modeId, ModeTableIndex = index,
                Offset = offset, Colors = colors, OpaqueTail = Slice(raw, 441, 49) };
        }
        private static byte[] RequireCopy(byte[] data, int length)
        {
            if (data == null || data.Length != length)
                throw new ArgumentException("Expected exactly " + length + " captured bytes.", nameof(data));
            return (byte[])data.Clone();
        }
        private static byte[] Slice(byte[] data, int offset, int length)
        {
            byte[] result = new byte[length]; Buffer.BlockCopy(data, offset, result, 0, length); return result;
        }
        private static string Hex(byte[] data)
        {
            return BitConverter.ToString(data).Replace("-", "");
        }
    }
}
