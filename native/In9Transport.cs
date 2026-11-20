using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace PeripheralHub
{
    /// <summary>
    /// Fixed IN9 configuration sender. Compile together with HidInventory.cs.
    /// A successful SetFeature is OS acceptance, not setting readback or hardware verification.
    /// Feature IOCTLs are synchronous; no hard driver I/O deadline is claimed.
    /// </summary>
    public static class In9Transport
    {
        private const int ReportLength = 33, MaxPackets = 256, PostSendDelayMilliseconds = 60;
        private const string MutexName = @"Local\PeripheralHub.HidConfig.In9-248A-5B2F";

        /// <summary>Return the single supported receiver's metadata ContainerId in GUID D format.</summary>
        public static string ContainerId()
        {
            EnsureWindows();
            using (var gate = new DeviceGate())
                return RequiredContainerId(FindSingle(HidInventory.Scan()));
        }

        /// <summary>
        /// Validate and snapshot the whole batch before any device enumeration/open, then send once
        /// under the shared IN9 mutex. Return the number of reports accepted by Windows, never a
        /// hardware verification count. A failure stops immediately; Exception.Data["OSAcceptedCount"]
        /// records prior successful calls. The failing report may have reached the device; no replay
        /// or automatic rollback occurs. Caller owns explicit recovery from a saved desired profile.
        /// </summary>
        public static int SendConfiguration(byte[][] packets)
        {
            return SendConfigurationCore(packets, null);
        }

        /// <summary>Compatibility alias for the profile bridge's fixed receiver metadata lookup.</summary>
        public static string In9ContainerId() { return ContainerId(); }

        /// <summary>
        /// Send a desired configuration only if its expected receiver ContainerId still matches.
        /// The identity comparison, open and full send all run inside the shared device mutex.
        /// </summary>
        public static int In9SendConfiguration(byte[][] packets, string expectedContainerId)
        {
            Guid expected;
            if (!Guid.TryParse(expectedContainerId, out expected) || expected == Guid.Empty)
                throw new ArgumentException("An explicit nonempty receiver ContainerId GUID is required.", nameof(expectedContainerId));
            return SendConfigurationCore(packets, expected.ToString("D"));
        }

        private static int SendConfigurationCore(byte[][] packets, string expectedContainerId)
        {
            byte[][] validated = ValidatePackets(packets);
            EnsureWindows();
            using (var gate = new DeviceGate())
            {
                HidInterface target = FindSingle(HidInventory.Scan());
                ValidateExpectedContainerId(target, expectedContainerId);
                using (SafeFileHandle handle = Open(target))
                {
                    VerifyOpenedTarget(handle);
                    return SendValidatedPackets(validated,
                        packet => HidD_SetFeature(handle, packet, packet.Length),
                        () => Marshal.GetLastWin32Error(), Thread.Sleep);
                }
            }
        }

        // Deliberately private: fixtures exercise validation/failure handling without any native IO.
        private static byte[][] ValidatePackets(byte[][] packets)
        {
            if (packets == null) throw new ArgumentNullException(nameof(packets));
            if (packets.Length < 1 || packets.Length > MaxPackets)
                throw new ArgumentException("IN9 configuration requires 1..256 reports.", nameof(packets));
            var copy = new byte[packets.Length][];
            for (int i = 0; i < copy.Length; i++)
            {
                byte[] source = packets[i];
                if (source == null || source.Length != ReportLength)
                    throw new ArgumentException("Every IN9 report must contain exactly 33 bytes.", nameof(packets));
                copy[i] = (byte[])source.Clone();
            }
            for (int i = 0; i < copy.Length; i++)
            {
                ValidatePacket(copy[i]);
                if (i > 0 && copy[i][4] != unchecked((byte)(copy[i - 1][4] + 1)))
                    throw new ArgumentException("IN9 batch sequence must increment by one, wrapping FF to 00.", nameof(packets));
            }
            // A macro must be complete and consecutive in this batch. Reassemble only its local
            // three-byte action stream, because 25-byte wire chunks can split an action triple.
            for (int i = 0; i < copy.Length; i++)
            {
                if (copy[i][2] != 0x0E) continue;
                int blocks = copy[i][5] & 15;
                if ((copy[i][5] >> 4) != 0 || i + blocks > copy.Length)
                    throw new ArgumentException("IN9 macro must start at fragment zero and include every fragment.", nameof(packets));
                byte slot = copy[i][7];
                var actions = new List<byte>();
                for (int block = 0; block < blocks; block++)
                {
                    byte[] packet = copy[i + block];
                    if (packet[2] != 0x0E || packet[5] != ((block << 4) | blocks) || packet[7] != slot)
                        throw new ArgumentException("IN9 macro fragments must be consecutive with unchanged slot/count.", nameof(packets));
                    int count = packet[6] - 1;
                    if ((block < blocks - 1 && count != 25) || (blocks > 1 && block == blocks - 1 && count == 0))
                        throw new ArgumentException("IN9 macro nonfinal fragments require 25 action bytes; only an empty single-fragment macro has no actions.", nameof(packets));
                    for (int j = 0; j < count; j++) actions.Add(packet[8 + j]);
                }
                if (actions.Count > 375 || actions.Count % 3 != 0 || Math.Max(1, (actions.Count + 24) / 25) != blocks)
                    throw new ArgumentException("IN9 macro must contain 0..125 complete three-byte actions in canonical fragments.", nameof(packets));
                for (int j = 0; j < actions.Count; j += 3)
                {
                    int kind = actions[j] & 0x70;
                    if (kind < 0x10 || kind > 0x60)
                        throw new ArgumentException("IN9 macro contains an action class unsupported by In9Codec.", nameof(packets));
                }
                i += blocks - 1;
            }
            return copy;
        }

        private static void ValidatePacket(byte[] packet)
        {
            if (packet[0] != 0x0C || packet[1] != 1 || packet[3] != 0)
                throw new ArgumentException("IN9 header must be 0C 01 CMD 00 SEQ.", "packets");
            int length = packet[6];
            if (length < 1 || length > 26)
                throw new ArgumentException("IN9 declared payload must be 1..26 bytes.", "packets");
            for (int i = 7 + length; i < ReportLength; i++)
                if (packet[i] != 0) throw new ArgumentException("IN9 bytes after the declared payload must be zero padding.", "packets");
            if (packet[2] != 0x0E && packet[5] != 1)
                throw new ArgumentException("IN9 scalar configuration requires fragment header 01.", "packets");
            switch (packet[2])
            {
                case 0x04:
                    RequireLength(length, 4);
                    if (packet[7] > 5) throw new ArgumentException("IN9 button slot must be 0..5.", "packets");
                    if (packet[8] == 0x90)
                    {
                        int repeatMode = packet[9] >> 4, repeatCount = packet[10];
                        if ((repeatMode != 1 && repeatMode != 2 && repeatMode != 4) ||
                            (repeatMode == 2 ? repeatCount == 0 : repeatCount != 0))
                            throw new ArgumentException("IN9 macro requires official mode1/2/4 and count1..255 only for mode2.", "packets");
                    }
                    break; // Other fixed/parameter function triples remain explicit target values.
                case 0x05:
                    RequireLength(length, 18);
                    int mask = packet[8], enabled = 0;
                    if (mask == 0 || (mask & 0xC0) != 0) throw new ArgumentException("IN9 DPI mask must select slots 0..5.", "packets");
                    for (int bit = 0; bit < 6; bit++) if ((mask & (1 << bit)) != 0) enabled++;
                    int ordinal = packet[7] >> 4;
                    if ((packet[7] & 15) != enabled || ordinal < 1 || ordinal > enabled)
                        throw new ArgumentException("IN9 DPI count/current enabled ordinal disagree with its mask.", "packets");
                    // BuildDpi3325: six one-based registers (49 base + 10 extended options),
                    // followed by four reserved zero bytes in its fixed 18-byte payload.
                    for (int slot = 0; slot < 6; slot++)
                    {
                        int register = packet[9 + slot * 2] | (packet[10 + slot * 2] << 8);
                        if (register < 1 || register > 59) throw new ArgumentException("IN9 DPI register is outside the codec's proven sensor3325 table.", "packets");
                    }
                    for (int j = 21; j < 25; j++)
                        if (packet[j] != 0) throw new ArgumentException("IN9 DPI reserved payload bytes must be zero.", "packets");
                    break;
                case 0x06: RequireLength(length, 24); break;
                case 0x07:
                    RequireLength(length, 1);
                    if (packet[7] != 1 && packet[7] != 2 && packet[7] != 4 && packet[7] != 8)
                        throw new ArgumentException("IN9 polling code must be 1, 2, 4 or 8.", "packets");
                    break;
                case 0x08: ValidateLighting(packet, length); break;
                // In9Codec.BuildLiftDetection proves command 09, not 0D.
                case 0x09:
                    RequireLength(length, 2);
                    if ((packet[7] != 1 && packet[7] != 2) || packet[8] != 0)
                        throw new ArgumentException("IN9 lift payload must be 01 00 or 02 00.", "packets");
                    break;
                case 0x0A: RequireLength(length, 1); break; // Explicit raw debounce byte, no guessed UI unit/range.
                case 0x0B:
                    RequireLength(length, 2);
                    if (packet[8] > 1) throw new ArgumentException("IN9 move-closes-light flag must be boolean.", "packets");
                    break;
                case 0x0C:
                    RequireLength(length, 1);
                    if (packet[7] > 1) throw new ArgumentException("IN9 motion wake flag must be boolean.", "packets");
                    break;
                case 0x0E:
                    int blocks = packet[5] & 15, index = packet[5] >> 4;
                    if (blocks < 1 || index >= blocks || packet[7] > 15)
                        throw new ArgumentException("IN9 macro requires slot 0..15 and a valid fragment index/count.", "packets");
                    break;
                default:
                    throw new ArgumentException("IN9 command has no proven configuration encoding; queries, reset, 0D and all unknown commands are rejected.", "packets");
            }
        }

        private static void RequireLength(int actual, int expected)
        {
            if (actual != expected) throw new ArgumentException("IN9 opcode requires payload length " + expected + ".", "packets");
        }
        private static void ValidateLighting(byte[] packet, int length)
        {
            byte mode = packet[7];
            if (mode > 9 || length < 2 || (packet[8] & 15) == 0 || (packet[8] >> 4) == 0)
                throw new ArgumentException("IN9 lighting requires mode 0..9 and nonzero speed/brightness nibbles.", "packets");
            int expected = 2;
            switch (mode)
            {
                case 1:
                    expected = 3;
                    if (packet[9] > 1) throw new ArgumentException("IN9 lighting direction must be 0 or 1.", "packets");
                    break;
                case 2:
                    int colors = packet[9];
                    if (colors > 7) throw new ArgumentException("IN9 lighting mode 2 allows at most seven selected colors.", "packets");
                    expected = 3 + colors * 3;
                    RequireLength(length, expected);
                    for (int i = 0; i < colors; i++)
                        if ((packet[10 + i * 3] | packet[11 + i * 3] | packet[12 + i * 3]) == 0)
                            throw new ArgumentException("IN9 lighting mode 2 omits black colors, as required by In9Codec.", "packets");
                    break;
                case 3: expected = 5; break;
                case 6: expected = 23; break;
                case 7: expected = 8; break;
            }
            RequireLength(length, expected);
        }

        private static int SendValidatedPackets(byte[][] packets, Func<byte[], bool> send, Func<int> lastError, Action<int> delay)
        {
            int accepted = 0;
            try
            {
                foreach (byte[] packet in packets)
                {
                    if (!send(packet)) throw NativeFailure("IN9 HidD_SetFeature", lastError());
                    accepted++;
                    delay(PostSendDelayMilliseconds);
                }
                return accepted;
            }
            catch (Exception error)
            {
                error.Data["OSAcceptedCount"] = accepted;
                error.Data["HardwareVerified"] = false;
                error.Data["AutomaticReplay"] = false;
                throw;
            }
        }

        private static bool IsTarget(HidInterface item)
        {
            return item != null && item.CapsRead && Eq(item.VendorId, "248A") && Eq(item.ProductId, "5B2F")
                && Eq(item.UsagePage, "FF00") && Eq(item.Usage, "0001")
                && item.InputReportBytes == 0 && item.OutputReportBytes == 0 && item.FeatureReportBytes == ReportLength
                && item.Path != null && item.Path.StartsWith(@"\\?\hid#vid_248a&pid_5b2f&mi_01&col04#", StringComparison.OrdinalIgnoreCase)
                && !item.Path.EndsWith(@"\kbd", StringComparison.OrdinalIgnoreCase);
        }
        private static bool Eq(string a, string b) { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        private static HidInterface FindSingle(IEnumerable<HidInterface> inventory)
        {
            HidInterface selected = null;
            foreach (HidInterface item in inventory)
            {
                if (!IsTarget(item)) continue;
                if (selected != null) throw new IOException("Multiple IN9 248A:5B2F FF00:0001 Feature33 collections found; target selection is ambiguous.");
                selected = item;
            }
            if (selected == null) throw new IOException("The IN9 248A:5B2F MI01 COL04 FF00:0001 Feature33-only configuration interface was not found.");
            return selected;
        }
        private static string RequiredContainerId(HidInterface target)
        {
            Guid id;
            if (!Guid.TryParse(target.ContainerId, out id) || id == Guid.Empty)
                throw new IOException("IN9 receiver ContainerId metadata is unavailable or invalid; device-bound configuration requires its identity.");
            return id.ToString("D");
        }
        private static void ValidateExpectedContainerId(HidInterface target, string expectedContainerId)
        {
            Guid actual = new Guid(RequiredContainerId(target));
            Guid expected;
            if (expectedContainerId != null && (!Guid.TryParse(expectedContainerId, out expected) || expected == Guid.Empty || expected != actual))
                throw new IOException("The IN9 receiver ContainerId changed since profile selection; no report was sent.");
        }
        private static SafeFileHandle Open(HidInterface target)
        {
            if (!IsTarget(target)) throw new IOException("Refusing to open an interface outside the fixed IN9 configuration target.");
            SafeFileHandle handle = CreateFileW(target.Path, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw NativeFailure("Open IN9 configuration collection", error);
            }
            return handle;
        }
        private static void VerifyOpenedTarget(SafeFileHandle handle)
        {
            var attributes = new HidAttributes { Size = Marshal.SizeOf(typeof(HidAttributes)) };
            if (!HidD_GetAttributes(handle, ref attributes)) throw NativeFailure("IN9 opened attributes", Marshal.GetLastWin32Error());
            IntPtr data;
            if (!HidD_GetPreparsedData(handle, out data)) throw NativeFailure("IN9 opened descriptor", Marshal.GetLastWin32Error());
            try
            {
                HidCaps caps;
                int status = HidP_GetCaps(data, out caps);
                if (status != 0x00110000) throw new IOException("IN9 HidP_GetCaps failed: 0x" + status.ToString("X8"));
                ValidateOpenedIdentity(attributes, caps);
            }
            finally { HidD_FreePreparsedData(data); }
        }
        private static void ValidateOpenedIdentity(HidAttributes attributes, HidCaps caps)
        {
            if (attributes.VendorID != 0x248A || attributes.ProductID != 0x5B2F
                || caps.UsagePage != 0xFF00 || caps.Usage != 1 || caps.FeatureReportByteLength != ReportLength
                || caps.InputReportByteLength != 0 || caps.OutputReportByteLength != 0)
                throw new IOException("Opened HID attributes/caps differ from the exact IN9 Feature33-only target; no report was sent.");
        }
        private static Exception NativeFailure(string operation, int error)
        {
            return new IOException(operation + " failed (Win32 " + error + "): " + new Win32Exception(error).Message
                + ". Earlier reports may have changed the device; OS acceptance is not hardware verification. No automatic replay occurred.", new Win32Exception(error));
        }
        private static void EnsureWindows()
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) throw new PlatformNotSupportedException("Windows HID transport is required.");
        }
        private sealed class DeviceGate : IDisposable
        {
            private readonly Mutex mutex;
            private bool owned;
            public DeviceGate()
            {
                mutex = new Mutex(false, MutexName);
                try
                {
                    try { owned = mutex.WaitOne(1500); }
                    catch (AbandonedMutexException) { owned = true; }
                    if (!owned) throw new TimeoutException("Another PeripheralHub operation holds the IN9 configuration mutex.");
                }
                catch { mutex.Dispose(); throw; }
            }
            public void Dispose()
            {
                try { if (owned) { owned = false; mutex.ReleaseMutex(); } }
                finally { mutex.Dispose(); }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HidAttributes { public int Size; public ushort VendorID, ProductID, VersionNumber; }
        [StructLayout(LayoutKind.Sequential)]
        private struct HidCaps
        {
            public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices;
            public ushort NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices;
            public ushort NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_SetFeature(SafeFileHandle handle, byte[] packet, int length);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetAttributes(SafeFileHandle handle, ref HidAttributes attributes);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr data);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_FreePreparsedData(IntPtr data);
        [DllImport("hid.dll")]
        private static extern int HidP_GetCaps(IntPtr data, out HidCaps caps);
    }
}
