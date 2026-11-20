using System;
using System.Collections.Generic;

namespace PeripheralHub
{
    /// <summary>Pure codec: no HID, process or file access.</summary>
    public static class AulaSettingsCodec
    {
        public const int LedLength = 128;
        public const int ModeTableOffset = 0x3A;
        public const int VerifiedSteadyBrightnessOffset = 0x3A;

        public sealed class LedSnapshot
        {
            public string RawHex { get; internal set; }
            public byte[] Raw { get; internal set; }
            public int SteadyBrightness { get; internal set; }
            public int HardwareModeCandidate { get; internal set; }
            public int SleepCodeCandidate { get; internal set; }
            public int DebounceCodeCandidate { get; internal set; }
            public int SleepSecondsFromInstalledProfile { get; internal set; }
            public string ActiveModeName { get; internal set; }
            public int ActiveModeTableIndex { get; internal set; }
            public ModeParameters[] ModeTableCandidates { get; internal set; }
            public string[] Evidence { get; internal set; }
        }
        public sealed class ModeParameters
        {
            public int TableIndex { get; internal set; }
            public int Offset { get; internal set; }
            public int BrightnessCandidate { get; internal set; }
            public int SpeedCandidate { get; internal set; }
            public int PaletteCandidate { get; internal set; }
            public bool MulticolorCandidate { get; internal set; }
            public string NameFromInstalledProfile { get; internal set; }
            public int HardwareModeId { get; internal set; }
            public bool HasSpeedControl { get; internal set; }
            public bool HasBrightnessControl { get; internal set; }
            public bool HasColorControl { get; internal set; }
            public bool HasMulticolorControl { get; internal set; }
            public int? ReadableSpeed { get { return HasSpeedControl ? (int?)SpeedCandidate : null; } }
            public int? ReadableColor { get { return HasColorControl ? (int?)PaletteCandidate : null; } }
        }
        private static readonly string[] ModeNames = {
            "常亮模式","呼吸模式","梦幻彩虹","一触即发","雨中漫步","彩虹轮盘","涟漪扩散","繁星点点",
            "踏雪无痕","川流不息","随波逐流","如影随形","正弦光波","左右扫描","旋转风车","七彩瀑布",
            "花开富贵","旋转风暴","自定义模式","关闭"
        };
        private static readonly int[] HardwareModeIds = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,21,0};
        private static bool ModeHasPalette(int index) {return index<18 && index!=2 && index!=14 && index!=15 && index!=16;}
        public sealed class Patch
        {
            // Only GUI-differentially verified field currently accepted for writing.
            public int? SteadyBrightness { get; set; }
        }
        public static LedSnapshot ParseLED128(byte[] source)
        {
            Validate(source);
            var copy = (byte[])source.Clone();
            var modes = new List<ModeParameters>();
            // Only modes 1..18 have a confirmed parameter slot (0x3A..0x5D).
            // Preserve bytes 0x5E..0x7D as opaque data, including custom/off mode storage.
            for (int i=0; i<18; ++i)
            {
                int offset=ModeTableOffset+i*2;
                modes.Add(new ModeParameters {
                    TableIndex=i, Offset=offset,
                    BrightnessCandidate=copy[offset],
                    SpeedCandidate=copy[offset+1]>>4,
                    PaletteCandidate=copy[offset+1]&0x0F,
                    MulticolorCandidate=(copy[offset+1]&0x0F)==7,
                    NameFromInstalledProfile=i<ModeNames.Length?ModeNames[i]:null,
                    HardwareModeId=i<HardwareModeIds.Length?HardwareModeIds[i]:-1,
                    HasSpeedControl=i>0 && i<18,
                    HasBrightnessControl=i<18,
                    HasColorControl=ModeHasPalette(i),
                    HasMulticolorControl=ModeHasPalette(i)
                });
            }
            return new LedSnapshot {
                RawHex=BitConverter.ToString(copy).Replace("-", ""), Raw=copy,
                SteadyBrightness=copy[VerifiedSteadyBrightnessOffset],
                HardwareModeCandidate=copy[0x0A],
                SleepCodeCandidate=copy[0x18],
                DebounceCodeCandidate=copy[0x03],
                SleepSecondsFromInstalledProfile=copy[0x18]*30,
                ActiveModeTableIndex=Array.IndexOf(HardwareModeIds,(int)copy[0x0A]),
                ActiveModeName=Array.IndexOf(HardwareModeIds,(int)copy[0x0A])>=0?ModeNames[Array.IndexOf(HardwareModeIds,(int)copy[0x0A])]:"未知模式",
                ModeTableCandidates=modes.ToArray(),
                Evidence=new[] {
                    "GUI brightness 4->3 changed only byte 0x3A; steady-mode brightness is differentially verified.",
                    "Static converter RVA0x8ABF0 stores selected hardware-mode mapping at0x0A; mode identity needs GUI confirmation.",
                    "Static converter RVA0x8AC60 writes brightness at0x3A+2*i, speed high nibble and palette low nibble at0x3B+2*i.",
                    "Other fields are candidates; this codec exposes no write API for them.",
                    "Length128 and tail5AA5 are required; original capture showed an apparent successful duplicate-fragment read with tail0000."
                }
            };
        }
        public static byte[] PatchLED128(byte[] source, Patch patch)
        {
            Validate(source);
            if(patch==null || !patch.SteadyBrightness.HasValue)
                throw new ArgumentException("At least one verified field is required.", nameof(patch));
            int value=patch.SteadyBrightness.Value;
            if(value<0 || value>4)
                throw new ArgumentOutOfRangeException(nameof(patch), "Brightness must be an official hardware level 0..4.");
            if(source[0x3A]>4)
                throw new ArgumentException("Unexpected current steady-brightness value; inspect device layout before patching.",nameof(source));
            var result=(byte[])source.Clone();
            result[VerifiedSteadyBrightnessOffset]=(byte)value;
            return result;
        }
        public static byte[] PatchBrightness(byte[] source, int value)
        {
            return PatchLED128(source,new Patch {SteadyBrightness=value});
        }
        public static bool IsSupportedMode(int mode)
        {
            return mode >= 1 && mode <= 18 && mode != 6 && mode != 9 && mode != 14 && mode != 18;
        }

        /// <summary>Patch one known LED128 field, preserving every other byte and unused nibble.
        /// Evidence: installed KB.ini/converter and f87pro-web-driver protocol documentation.
        /// Transport and callers must separately verify device identity, backup and full readback.
        /// </summary>
        public static byte[] PatchSetting(byte[] source, string setting, int value)
        {
            Validate(source);
            var result = (byte[])source.Clone();
            int offset;
            switch (setting)
            {
                case "activeMode":
                    if (value != 0 && !IsSupportedMode(value)) throw new ArgumentOutOfRangeException(nameof(value), "Unsupported F87 PRO lighting mode.");
                    offset = 0x0A;
                    break;
                case "sleepCode":
                    if (Array.IndexOf(new[] { 0,1,2,3,4,6,8,10,20,30,40 }, value) < 0)
                        throw new ArgumentOutOfRangeException(nameof(value), "Sleep code is outside the installed profile options.");
                    offset = 0x18;
                    break;
                case "debounce":
                    RequireLevel(value); offset = 0x03;
                    break;
                case "brightness":
                case "speed":
                case "colorIndex":
                    int mode = source[0x0A];
                    if (!IsSupportedMode(mode)) throw new ArgumentException("Current mode has no validated parameter slot.", nameof(source));
                    offset = ModeTableOffset + 2 * (mode - 1);
                    if (setting == "brightness") { RequireLevel(value); break; }
                    offset++;
                    if (setting == "speed")
                    {
                        if (mode == 1) throw new ArgumentException("Steady lighting does not have speed control.", nameof(setting));
                        RequireLevel(value);
                        value = (value << 4) | (source[offset] & 0x0F);
                    }
                    else
                    {
                        if (!ModeHasPalette(mode - 1)) throw new ArgumentException("This effect uses fixed colors.", nameof(setting));
                        if (value < 0 || value > 7) throw new ArgumentOutOfRangeException(nameof(value), "Color index must be 0..7.");
                        value = (source[offset] & 0xF0) | value;
                    }
                    break;
                default: throw new ArgumentException("Unknown LED setting.", nameof(setting));
            }
            result[offset] = (byte)value;
            return result;
        }
        private static void RequireLevel(int value)
        {
            if (value < 0 || value > 4) throw new ArgumentOutOfRangeException(nameof(value), "Hardware level must be 0..4.");
        }
        public static void Validate(byte[] source)
        {
            if(source==null || source.Length!=LedLength)
                throw new ArgumentException("An exact128-byte original LED block is required.",nameof(source));
            if(source[126]!=0x5A || source[127]!=0xA5)
                throw new ArgumentException("LED trailer mismatch; possible wrong layout or incomplete/reordered read.",nameof(source));
        }
    }
}
