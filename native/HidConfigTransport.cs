using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace PeripheralHub
{
    /// <summary>
    /// Direct configuration transport for two explicitly identified vendor HID collections.
    /// No keyboard/mouse input collection or firmware command is accepted; setting writes are
    /// restricted to allowlisted vendor commands and always verified by full readback.
    /// Compile together with HidInventory.cs in one Add-Type invocation.
    /// </summary>
    public static class HidConfigTransport
    {
        private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000;
        private const uint ShareReadWrite = 3, OpenExisting = 3, FileFlagOverlapped = 0x40000000;
        private const int ErrorIoPending = 997, ErrorIoIncomplete = 996, ErrorOperationAborted = 995;
        private const uint WaitObject0 = 0, WaitTimeout = 258, WaitFailed = 0xFFFFFFFF;
        private const int AulaReportLength = 20, In9ReportLength = 33;
        private const byte AulaReportId = 0x13, In9ReportId = 0x0C;

        /// <summary>
        /// Diagnostic single-shot raw reader for an allowlisted query command. Sends the query,
        /// then returns every distinct 20-byte reply received before the first timeout. Only
        /// report ID and per-packet dedup are enforced; no checksum/length/fragment validation.
        /// Purpose: characterizing reply framing for commands whose layout is still under study.
        /// </summary>
        public static byte[][] AulaQueryRaw(byte command, byte selector, int timeoutMs = 1500, bool armReadBeforeSend = false)
        {
            if (command != 0x05 && command != 0x07 && command != 0x41 && command != 0x49)
                throw new ArgumentOutOfRangeException(nameof(command), "Raw diagnostic probing is limited to commands 05/07/41/49.");
            if ((command == 0x05 || command == 0x07 || command == 0x49) && selector != 0)
                throw new ArgumentOutOfRangeException(nameof(selector), "Raw identity, state and palette probes require selector zero.");
            if (command == 0x41 && selector > 3)
                throw new ArgumentOutOfRangeException(nameof(selector), "Raw matrix probes accept selectors 0..3 only.");
            if (timeoutMs < 1 || timeoutMs > 10000) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
            EnsureWindows(); EnsureAulaDriverStopped();
            var received = new List<byte[]>();
            using (var gate = new DeviceGate("Aula-3554-FA09", timeoutMs))
            {
                using (SafeFileHandle handle = Open(FindSingle(false), true))
                {
                    VerifyOpenedTarget(handle, false);
                    byte[] packet = new byte[AulaReportLength];
                    packet[0] = AulaReportId; packet[1] = command; packet[2] = 1; packet[4] = (byte)(selector << 4);
                    packet[19] = Checksum(packet);
                    FlushAulaQueue(handle);
                    Stopwatch clock = Stopwatch.StartNew();
                    Action queryAfterReadArmed = null;
                    if (armReadBeforeSend) queryAfterReadArmed = () => Transfer(handle, packet, true, Remaining(clock, timeoutMs));
                    else Transfer(handle, packet, true, Remaining(clock, timeoutMs));
                    while (clock.ElapsedMilliseconds < timeoutMs)
                    {
                        byte[] reply = new byte[AulaReportLength]; reply[0] = AulaReportId;
                        try {
                            using (var operation = new OverlappedOperation(handle, reply, false))
                                operation.Execute((int)Math.Max(1, timeoutMs - clock.ElapsedMilliseconds), queryAfterReadArmed);
                            queryAfterReadArmed = null;
                        }
                        catch (TimeoutException) { break; }
                        bool duplicate = false;
                        foreach (byte[] prior in received)
                        {
                            duplicate = true;
                            for (int i = 0; i < AulaReportLength; i++) if (prior[i] != reply[i]) { duplicate = false; break; }
                            if (duplicate) break;
                        }
                        if (!duplicate) received.Add(reply);
                        if (received.Count >= 64) break;
                    }
                }
            }
            return received.ToArray();
        }

        /// <summary>Metadata-only enumeration, restricted to the supported vendor collections.</summary>
        public static List<HidInterface> ListCandidates()
        {
            EnsureWindows();
            var result = new List<HidInterface>();
            foreach (HidInterface item in HidInventory.Scan())
                if (IsIn9(item) || IsAula(item)) result.Add(item);
            return result;
        }

        /// <summary>
        /// Send only the IN9 0x20 configuration query and return its 33-byte feature reply.
        /// Feature-report IOCTLs are synchronous Windows HID calls; no hard I/O timeout is claimed.
        /// </summary>
        public static byte[] In9Exchange(byte[] request, bool readResponse)
        {
            byte[] packet = ValidateIn9Request(request);
            if (!readResponse)
                throw new ArgumentException("Transport requires readResponse=true; no send-only operation is exposed.", nameof(readResponse));
            EnsureWindows();
            using (var gate = new DeviceGate("In9-248A-5B2F", 1500))
            {
                HidInterface target = FindSingle(true);
                using (SafeFileHandle handle = Open(target, false))
                {
                    VerifyOpenedTarget(handle, true);
                    if (!HidD_SetFeature(handle, packet, packet.Length))
                        throw NativeFailure("IN9 query HidD_SetFeature", Marshal.GetLastWin32Error());
                    Thread.Sleep(15);
                    byte[] response = new byte[In9ReportLength];
                    for (int i = 0; i < response.Length; i++) response[i] = 0xFF;
                    response[0] = In9ReportId;
                    if (!HidD_GetFeature(handle, response, response.Length))
                        throw NativeFailure("IN9 query HidD_GetFeature", Marshal.GetLastWin32Error());
                    ValidateIn9Response(packet, response);
                    return response;
                }
            }
        }

        /// <summary>Read the OEM receiver's 07 readiness flag. Zero is not ready;
        /// it does not distinguish sleeping, powered off or a disconnected keyboard.</summary>
        public static int AulaReadReadiness(int timeoutMs = 1500)
        {
            var frames = AulaQueryRaw(0x07, 0, timeoutMs, true);
            int? state = null;
            foreach (var frame in frames) {
                int next = ParseAulaReadiness(frame);
                if (state.HasValue && state.Value != next) throw new InvalidDataException("AULA readiness changed during the query; read again.");
                state = next;
            }
            if (!state.HasValue) throw new TimeoutException("AULA receiver did not respond to its readiness query.");
            return state.Value;
        }
        private static int ParseAulaReadiness(byte[] frame)
        {
            if (frame == null || frame.Length != 20 || frame[0] != 0x13 || frame[1] != 7 || frame[2] != 1 || frame[3] != 0
                || frame[4] != 1 || frame[19] != Checksum(frame) || frame[5] > 1)
                throw new InvalidDataException("Invalid AULA readiness response; no connection state inferred.");
            return frame[5];
        }

        public static string AulaContainerId()
        {
            EnsureWindows();
            var target = FindSingle(false);
            if (string.IsNullOrWhiteSpace(target.ContainerId)) throw new IOException("AULA receiver ContainerId is unavailable; device-bound recovery is required.");
            return target.ContainerId;
        }

        public sealed class In9StatusSnapshot
        {
            public int PollingHz { get; internal set; }
            public int ActiveEnabledOrdinal { get; internal set; }
            public DateTime ObservedAtUtc { get; internal set; }
            public bool ContainsDpiValues { get { return false; } }
        }

        private static bool IsIn9Status(HidInterface item)
        {
            return item != null && item.CapsRead && Eq(item.VendorId, "248A") && Eq(item.ProductId, "5B2F")
                && Eq(item.UsagePage, "0001") && Eq(item.Usage, "0000")
                && item.InputReportBytes == 33 && item.OutputReportBytes == 0 && item.FeatureReportBytes == 0
                && item.Path != null && item.Path.IndexOf("hid#vid_248a&pid_5b2f&mi_01&col06#", StringComparison.OrdinalIgnoreCase) >= 0
                && !item.Path.EndsWith("\\kbd", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>One bounded passive read of the dedicated COL06 configuration notification.
        /// No write, mouse movement collection or ordinary keyboard input is opened.
        /// Null means no fresh matching status observed; it does not mean zero DPI or offline.
        /// </summary>
        public static In9StatusSnapshot In9ReadStatus(int timeoutMs = 750, bool probeWithInfoQuery = false, bool getCurrentReport = false)
        {
            if (timeoutMs < 1 || timeoutMs > 5000) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
            EnsureWindows();
            using (var gate = new DeviceGate("In9-248A-5B2F", timeoutMs))
            {
                HidInterface target = null, feature = null;
                foreach (var item in HidInventory.Scan())
                {
                    if (IsIn9(item)) {
                        if (feature != null) throw new InvalidOperationException("Multiple IN9 receivers are present.");
                        feature = item;
                    }
                    if (!IsIn9Status(item)) continue;
                    if (target != null) throw new InvalidOperationException("Multiple IN9 status collections are present; refusing ambiguous selection.");
                    target = item;
                }
                if (target == null || feature == null) throw new IOException("The dedicated IN9 configuration collections were not found.");
                if (string.IsNullOrEmpty(target.ContainerId) || !Eq(target.ContainerId, feature.ContainerId))
                    throw new IOException("IN9 Feature and status interfaces do not have the same verified ContainerId.");
                using (var handle = CreateFileW(target.Path, GenericRead, ShareReadWrite, IntPtr.Zero, OpenExisting, FileFlagOverlapped, IntPtr.Zero))
                {
                    if (handle.IsInvalid) throw NativeFailure("Open IN9 status collection", Marshal.GetLastWin32Error());
                    VerifyIn9StatusTarget(handle);
                    if (getCurrentReport) {
                        var current = new byte[33]; current[0] = 5;
                        if (!HidD_GetInputReport(handle, current, current.Length)) throw NativeFailure("IN9 GetInputReport", Marshal.GetLastWin32Error());
                        return ParseIn9Status(current);
                    }
                    if (!HidD_FlushQueue(handle)) throw NativeFailure("IN9 status queue flush", Marshal.GetLastWin32Error());
                    var clock = Stopwatch.StartNew();
                    Action afterReadArmed = null;
                    if (probeWithInfoQuery) afterReadArmed = () => {
                        using (var infoHandle = Open(feature, false)) {
                            VerifyOpenedTarget(infoHandle, true);
                            var query = new byte[33]; query[0] = 0x0C; query[1] = 1; query[2] = 0x20; query[4] = 0x6D;
                            if (!HidD_SetFeature(infoHandle, query, query.Length)) throw NativeFailure("IN9 existing info probe", Marshal.GetLastWin32Error());
                            var response = new byte[33]; response[0] = 0x0C;
                            if (!HidD_GetFeature(infoHandle, response, response.Length)) throw NativeFailure("IN9 existing info response", Marshal.GetLastWin32Error());
                            ValidateIn9Response(query, response);
                        }
                    };
                    while (clock.ElapsedMilliseconds < timeoutMs)
                    {
                        var reply = new byte[33];
                        try {
                            using (var operation = new OverlappedOperation(handle, reply, false))
                                operation.Execute(Math.Max(1, timeoutMs - (int)clock.ElapsedMilliseconds), afterReadArmed);
                            afterReadArmed = null;
                        }
                        catch (TimeoutException) { return null; }
                        // Unexpected notifications are discarded without retaining their bytes.
                        if (reply[0] != 5 || reply[1] != 6) continue;
                        return ParseIn9Status(reply);
                    }
                    return null;
                }
            }
        }

        private static In9StatusSnapshot ParseIn9Status(byte[] reply)
        {
            if (reply == null || reply.Length != 33 || reply[0] != 5 || reply[1] != 6)
                throw new InvalidDataException("Unexpected IN9 configuration status envelope.");
            int hz;
            switch (reply[3]) { case 1: hz = 1000; break; case 2: hz = 500; break; case 4: hz = 250; break; case 8: hz = 125; break; default: throw new InvalidDataException("Unknown IN9 polling rate code."); }
            if (reply[4] < 1 || reply[4] > 6) throw new InvalidDataException("Invalid IN9 enabled-stage ordinal.");
            return new In9StatusSnapshot { PollingHz = hz, ActiveEnabledOrdinal = reply[4] - 1, ObservedAtUtc = DateTime.UtcNow };
        }

        private static void VerifyIn9StatusTarget(SafeFileHandle handle)
        {
            var attributes = new HidAttributes { Size = Marshal.SizeOf(typeof(HidAttributes)) };
            if (!HidD_GetAttributes(handle, ref attributes)) throw NativeFailure("IN9 status attributes", Marshal.GetLastWin32Error());
            IntPtr data;
            if (!HidD_GetPreparsedData(handle, out data)) throw NativeFailure("IN9 status descriptor", Marshal.GetLastWin32Error());
            try
            {
                HidCaps caps;
                if (HidP_GetCaps(data, out caps) != 0x00110000 || attributes.VendorID != 0x248A || attributes.ProductID != 0x5B2F
                    || caps.UsagePage != 1 || caps.Usage != 0 || caps.InputReportByteLength != 33 || caps.OutputReportByteLength != 0 || caps.FeatureReportByteLength != 0)
                    throw new IOException("Opened interface is not the dedicated IN9 configuration status collection.");
            }
            finally { HidD_FreePreparsedData(data); }
        }

        /// <summary>
        /// Queries AULA commands 0x05/0x07/0x44 on report 0x13 only.
        /// 0x44 is GetLED128 (shared lighting/sleep/debounce/tap settings), not a generic write command.
        /// expectedLength is the exact concatenated payload length, excluding each packet header/checksum.
        /// Timeout covers acquisition, enumeration and all overlapped transfers; cancellation is drained
        /// before memory release, so a malfunctioning driver may extend cancellation cleanup beyond it.
        /// </summary>
        public static byte[] AulaQuery(byte reportId, byte command, int expectedLength, int timeoutMs = 1500)
        {
            return AulaQuerySelector(reportId, command, expectedLength, 0, timeoutMs);
        }

        /// <summary>
        /// Query a fixed-length allowed block. Only matrix 0x41 accepts selectors 0..3;
        /// identity 0x05, state 0x07, LED 0x44 and palette 0x49 require selector zero.
        /// Reader/caller validates block markers and semantics before promoting a snapshot to a baseline.
        /// </summary>
        public static byte[] AulaQuerySelector(byte reportId, byte command, int expectedLength, byte selector, int timeoutMs = 1500)
        {
            return AulaQuerySelectorCore(reportId, command, expectedLength, selector, timeoutMs, true);
        }

        /// <summary>Single-attempt query for evidence capture; timeout/protocol errors are never replayed.</summary>
        public static byte[] AulaQuerySelectorOnce(byte reportId, byte command, int expectedLength, byte selector, int timeoutMs = 1500)
        {
            return AulaQuerySelectorCore(reportId, command, expectedLength, selector, timeoutMs, false);
        }

        public sealed class AulaSnapshotMatrixBlock
        {
            public int Layer { get; internal set; }
            public byte[] Raw { get; internal set; }
            public int ActualLength { get { return Raw == null ? 0 : Raw.Length; } }
            public bool BlockComplete { get { return Raw != null && Raw.Length == 512; } }
            public bool MarkerPresent { get { return BlockComplete && Raw[508] == 0 && Raw[509] == 0 && Raw[510] == 0x5A && Raw[511] == 0xA5; } }
        }

        public sealed class AulaSnapshotPaletteBlock
        {
            public byte[] Raw { get; internal set; }
            public int ActualLength { get { return Raw == null ? 0 : Raw.Length; } }
            public bool BlockComplete { get { return Raw != null && Raw.Length == 512; } }
            public bool MarkerPresent { get { return BlockComplete && Raw[506] == 0x5A && Raw[507] == 0xA5; } }
        }

        public sealed class AulaSnapshotQueryTrace
        {
            private readonly List<byte[]> _packets = new List<byte[]>();
            public byte Command { get; internal set; }
            public byte Selector { get; internal set; }
            public bool CaptureLimitReached { get; private set; }
            public byte[][] RawPackets { get { return _packets.ToArray(); } }
            internal void Record(byte[] packet)
            {
                if (_packets.Count == 512) { CaptureLimitReached = true; return; }
                _packets.Add((byte[])packet.Clone());
            }
        }

        public sealed class AulaConfigurationSnapshot
        {
            public string ContainerId { get; internal set; }
            public string InstanceId { get; internal set; }
            public byte[] IdentityBefore { get; internal set; }
            public byte[] IdentityAfter { get; internal set; }
            public bool IdentityStable { get; internal set; }
            public bool SnapshotComplete { get; internal set; }
            public bool WriteBaselineEligible { get { return false; } }
            public AulaSnapshotMatrixBlock[] Matrices { get; internal set; }
            public AulaSnapshotPaletteBlock Palette { get; internal set; }
            public byte? FailedCommand { get; internal set; }
            public byte? FailedSelector { get; internal set; }
            public string FailureMessage { get; internal set; }
            public AulaSnapshotQueryTrace[] QueryTraces { get; internal set; }
        }

        /// <summary>
        /// Reads PSD, all four matrix selectors, palette, and PSD again under one mutex and one HID
        /// handle. The shared deadline is 1..30000 ms. This is a diagnostic same-session snapshot,
        /// not a recovery baseline. No failed query is retried; completed blocks survive later failure.
        /// </summary>
        public static AulaConfigurationSnapshot AulaReadConfigurationSnapshotOnce(int timeoutMs = 30000)
        {
            if (timeoutMs < 1 || timeoutMs > 30000) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
            EnsureWindows(); EnsureAulaDriverStopped();
            Stopwatch clock = Stopwatch.StartNew();
            using (var gate = new DeviceGate("Aula-3554-FA09", Remaining(clock, timeoutMs)))
            {
                EnsureAulaDriverStopped();
                HidInterface target = FindSingle(false);
                if (string.IsNullOrWhiteSpace(target.ContainerId)) throw new IOException("AULA ContainerId is unavailable; a same-session snapshot cannot be attributed.");
                using (SafeFileHandle handle = Open(target, true))
                {
                    VerifyOpenedTarget(handle, false);
                    var traces = new List<AulaSnapshotQueryTrace>();
                    Func<byte, byte, int, byte[]> read = (command, selector, expectedLength) =>
                    {
                        int remaining = Remaining(clock, timeoutMs);
                        byte[] query = BuildAulaQuerySelector(AulaReportId, command, expectedLength, selector, remaining);
                        int[] acceptedLengths = AulaResponseLengths(command, expectedLength);
                        var trace = new AulaSnapshotQueryTrace { Command = command, Selector = selector };
                        traces.Add(trace);
                        return ReadAulaBlock(handle, query, command, acceptedLengths, clock, timeoutMs, trace);
                    };
                    AulaConfigurationSnapshot snapshot = CaptureAulaSnapshotCore(target.ContainerId, target.InstanceId, read);
                    snapshot.QueryTraces = traces.ToArray();
                    return snapshot;
                }
            }
        }

        private static AulaConfigurationSnapshot CaptureAulaSnapshotCore(string containerId, string instanceId, Func<byte, byte, int, byte[]> read)
        {
            if (string.IsNullOrWhiteSpace(containerId)) throw new ArgumentException("ContainerId is required for an AULA snapshot.", nameof(containerId));
            if (read == null) throw new ArgumentNullException(nameof(read));
            var snapshot = new AulaConfigurationSnapshot
            {
                ContainerId = containerId,
                InstanceId = instanceId,
                Matrices = new[]
                {
                    new AulaSnapshotMatrixBlock { Layer = 0 },
                    new AulaSnapshotMatrixBlock { Layer = 1 },
                    new AulaSnapshotMatrixBlock { Layer = 2 },
                    new AulaSnapshotMatrixBlock { Layer = 3 }
                },
                Palette = new AulaSnapshotPaletteBlock(),
                QueryTraces = new AulaSnapshotQueryTrace[0]
            };
            byte command = 0x05, selector = 0;
            try
            {
                snapshot.IdentityBefore = ExactSnapshotBlock(read(0x05, 0, 10), 10, "identity-before");
                if (!MatchesF87ProPsd(snapshot.IdentityBefore)) throw new InvalidDataException("AULA initial PSD does not match F87 PRO.");
                for (byte layer = 0; layer < 4; layer++)
                {
                    command = 0x41; selector = layer;
                    byte[] raw = read(command, selector, 512);
                    if (raw == null || (raw.Length != 504 && raw.Length != 512)) throw new InvalidDataException("AULA matrix response length must be exactly 504 or 512 bytes.");
                    snapshot.Matrices[layer].Raw = (byte[])raw.Clone();
                }
                command = 0x49; selector = 0;
                byte[] palette = read(command, selector, 512);
                if (palette == null || (palette.Length != 490 && palette.Length != 512)) throw new InvalidDataException("AULA palette response length must be exactly 490 or 512 bytes.");
                snapshot.Palette.Raw = (byte[])palette.Clone();
                command = 0x05; selector = 0;
                snapshot.IdentityAfter = ExactSnapshotBlock(read(command, selector, 10), 10, "identity-after");
                snapshot.IdentityStable = SameF87ProPsd(snapshot.IdentityBefore, snapshot.IdentityAfter);
                if (!snapshot.IdentityStable) throw new InvalidDataException("AULA PSD changed during the same-session snapshot.");
                snapshot.SnapshotComplete = snapshot.IdentityStable
                    && Array.TrueForAll(snapshot.Matrices, block => block != null && block.BlockComplete)
                    && snapshot.Palette.BlockComplete;
            }
            catch (Exception error)
            {
                snapshot.FailedCommand = command;
                snapshot.FailedSelector = selector;
                snapshot.FailureMessage = error.Message;
                snapshot.SnapshotComplete = false;
                if (snapshot.IdentityBefore != null && snapshot.IdentityAfter != null)
                    snapshot.IdentityStable = SameF87ProPsd(snapshot.IdentityBefore, snapshot.IdentityAfter);
            }
            return snapshot;
        }

        private static byte[] ExactSnapshotBlock(byte[] data, int expectedLength, string name)
        {
            if (data == null || data.Length != expectedLength) throw new InvalidDataException("AULA " + name + " block is not exactly " + expectedLength + " bytes.");
            return (byte[])data.Clone();
        }

        private static bool MatchesF87ProPsd(byte[] identity)
        {
            byte[] expected = { 3, 0, 0, 0, 1, 0x0B };
            if (identity == null || identity.Length != 10) return false;
            for (int i = 0; i < expected.Length; i++) if (identity[i] != expected[i]) return false;
            return true;
        }

        private static bool SameF87ProPsd(byte[] first, byte[] second)
        {
            if (!MatchesF87ProPsd(first) || !MatchesF87ProPsd(second)) return false;
            for (int i = 0; i < 6; i++) if (first[i] != second[i]) return false;
            return true;
        }

        private static byte[] AulaQuerySelectorCore(byte reportId, byte command, int expectedLength, byte selector, int timeoutMs, bool retry)
        {
            byte[] query = BuildAulaQuerySelector(reportId, command, expectedLength, selector, timeoutMs);
            EnsureWindows(); EnsureAulaDriverStopped();
            Stopwatch clock = Stopwatch.StartNew();
            using (var gate = new DeviceGate("Aula-3554-FA09", Remaining(clock, timeoutMs)))
            {
                EnsureAulaDriverStopped();
                using (SafeFileHandle handle = Open(FindSingle(false), true))
                {
                    VerifyOpenedTarget(handle, false);
                    int[] acceptedLengths = AulaResponseLengths(command, expectedLength);
                    Func<byte[]> read = () => ReadAulaBlock(handle, query, command, acceptedLengths, clock, timeoutMs);
                    return RunAulaRead(read, retry, clock, timeoutMs);
                }
            }
        }

        /// <summary>
        /// Write all ten LED/settings packets once, then query GetLED128 on the same handle under
        /// the same mutex and require an exact readback. Only read queries may retry (at most twice,
        /// within the shared deadline). Any write/ACK failure stops immediately, with no replay.
        /// Caller owns baseline persistence and any explicit restoration after a partial write.
        /// </summary>
        public static byte[] AulaWriteReadLed(byte[] payload)
        {
            if (payload == null) throw new ArgumentNullException(nameof(payload));
            byte[] expected = (byte[])payload.Clone();
            byte[][] packets = BuildAulaLedPackets(expected);
            const int timeoutMs = 20000;
            byte[] query = BuildAulaQuery(AulaReportId, 0x44, 128, timeoutMs);
            EnsureWindows(); EnsureAulaDriverStopped();
            Stopwatch clock = Stopwatch.StartNew();
            using (var gate = new DeviceGate("Aula-3554-FA09", Remaining(clock, timeoutMs)))
            {
                EnsureAulaDriverStopped();
                using (SafeFileHandle handle = Open(FindSingle(false), true))
                {
                    VerifyOpenedTarget(handle, false);
                    FlushAulaQueue(handle);
                    return WriteOnceAndVerifyLed(expected,
                        () => WriteAulaPackets(handle, packets, clock, timeoutMs),
                        () => ReadAulaBlock(handle, query, 0x44, new[] { 128 }, clock, timeoutMs), clock, timeoutMs);
                }
            }
        }

        // This seam also permits pure fixture coverage of failure handling: the write callback
        // is deliberately outside RetryAulaRead, including when ACK or verification fails.
        private static byte[] WriteOnceAndVerifyLed(byte[] expected, Action write, Func<byte[]> read, Stopwatch clock, int timeoutMs)
        {
            write();
            byte[] actual = RetryAulaRead(read, clock, timeoutMs);
            if (actual == null || actual.Length != expected.Length)
                throw new InvalidDataException("AULA LED readback has an unexpected length. Configuration may be partially changed; no automatic replay occurred.");
            for (int index = 0; index < expected.Length; index++)
                if (actual[index] != expected[index])
                    throw new InvalidDataException("AULA LED settings were transmitted but readback differs at payload byte " + index
                        + ". The device may be partially modified; restore the saved baseline and verify again. No automatic replay occurred.");
            return actual;
        }

        private static void WriteAulaPackets(SafeFileHandle handle, byte[][] packets, Stopwatch clock, int timeoutMs)
        {
            foreach (byte[] packet in packets)
            {
                EnsureAulaDriverStopped();
                Thread.Sleep(25);
                Transfer(handle, packet, true, Remaining(clock, timeoutMs));
                byte[] ack = new byte[AulaReportLength];
                Transfer(handle, ack, false, Math.Min(1000, Remaining(clock, timeoutMs)));
                if (ack[0] == 0xFF || ack[1] != packet[1])
                    throw new InvalidDataException("AULA write ACK header mismatch after packet " + packet[3] + ". ACK=" + BitConverter.ToString(ack) + "; configuration may be partially changed. No automatic replay occurred.");
                if ((ack[2] & 0x80) != 0)
                    throw new InvalidDataException("AULA device reported a write error after packet " + packet[3] + ". ACK=" + BitConverter.ToString(ack) + "; no automatic replay occurred.");
            }
        }

        private static byte[][] BuildAulaLedPackets(byte[] payload)
        {
            if (payload == null) throw new ArgumentNullException(nameof(payload));
            if (payload.Length != 128 || payload[126] != 0x5A || payload[127] != 0xA5)
                throw new ArgumentException("AULA LED/settings payload must be exactly 128 bytes ending 5A A5.", nameof(payload));
            byte[] source = (byte[])payload.Clone();
            byte[][] packets = new byte[10][];
            for (int index = 0; index < packets.Length; index++)
            {
                byte[] packet = new byte[AulaReportLength];
                int offset = index * 14, count = Math.Min(14, source.Length - offset);
                packet[0] = AulaReportId; packet[1] = 0x04; packet[2] = 10;
                packet[3] = (byte)index; packet[4] = (byte)count;
                Buffer.BlockCopy(source, offset, packet, 5, count);
                packet[19] = Checksum(packet); packets[index] = packet;
            }
            return packets;
        }

        private static byte[] ValidateIn9WriteRequest(byte[] request)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.Length != In9ReportLength) throw new ArgumentException("IN9 settings report must be exactly 33 bytes.", nameof(request));
            byte[] packet = (byte[])request.Clone();
            if (packet[0] != In9ReportId || packet[1] != 1 || packet[3] != 0)
                throw new ArgumentException("IN9 settings header must be 0C 01 CMD 00 SEQ.", nameof(request));
            byte command = packet[2];
            if (command != 0x04 && command != 0x05 && command != 0x06 && command != 0x07 && command != 0x08
                && command != 0x0B && command != 0x0C && command != 0x0E)
                throw new ArgumentException("IN9 command is outside the settings allowlist; commands 09, 0A, reset 0F and firmware commands are excluded.", nameof(request));
            int total = packet[5] & 0x0F, index = packet[5] >> 4;
            if (total < 1 || index >= total) throw new ArgumentException("IN9 packet index/total nibble is invalid.", nameof(request));
            int length = packet[6];
            if (length < 1 || length > 26) throw new ArgumentException("IN9 settings payload length must be 1..26 bytes.", nameof(request));
            for (int i = 7 + length; i < packet.Length; i++)
                if (packet[i] != 0) throw new ArgumentException("IN9 bytes after the declared payload must be zero padding.", nameof(request));
            return packet;
        }

        private static void FlushAulaQueue(SafeFileHandle handle)
        {
            EnsureAulaDriverStopped();
            if (!HidD_SetNumInputBuffers(handle, 256)) throw NativeFailure("AULA receive queue capacity", Marshal.GetLastWin32Error());
            if (!HidD_FlushQueue(handle)) throw NativeFailure("AULA HidD_FlushQueue before query", Marshal.GetLastWin32Error());
        }

        private static void EnsureAulaDriverStopped()
        {
            Process[] processes = Process.GetProcessesByName("OemDrv");
            try
            {
                if (processes.Length != 0)
                    throw new IOException("AULA OemDrv is running. Close the original driver application before any AULA query or write; concurrent access can steal reply packets and corrupt configuration readback.");
            }
            finally { foreach (Process process in processes) process.Dispose(); }
        }

        private static byte[] ValidateIn9Request(byte[] request)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.Length != In9ReportLength) throw new ArgumentException("IN9 feature report must be exactly 33 bytes.", nameof(request));
            byte[] packet = (byte[])request.Clone();
            if (packet[0] != In9ReportId || packet[1] != 0x01 || packet[2] != 0x20 || packet[3] != 0)
                throw new ArgumentException("Only IN9 query header 0C 01 20 00 SEQ is accepted.", nameof(request));
            for (int i = 5; i < packet.Length; i++)
                if (packet[i] != 0) throw new ArgumentException("IN9 0x20 query must have zero payload/padding bytes 5..32.", nameof(request));
            return packet;
        }

        private static void ValidateIn9Response(byte[] request, byte[] response)
        {
            if (response == null || response.Length != In9ReportLength)
                throw new InvalidDataException("IN9 reply must contain exactly 33 bytes.");
            for (int i = 0; i <= 4; i++)
                if (response[i] != request[i]) throw new InvalidDataException("IN9 reply header or sequence differs from the query; another controller may be using the device.");
            if (response[5] != 0x01 || response[6] != 0x10)
                throw new InvalidDataException("IN9 0x20 reply has an unexpected status/data-length header (expected 01 10). No configuration was interpreted.");
        }

        private static byte[] BuildAulaQuery(byte reportId, byte command, int expectedLength, int timeoutMs)
        {
            return BuildAulaQuerySelector(reportId, command, expectedLength, 0, timeoutMs);
        }

        private static byte[] BuildAulaQuerySelector(byte reportId, byte command, int expectedLength, byte selector, int timeoutMs)
        {
            if (reportId != AulaReportId) throw new ArgumentOutOfRangeException(nameof(reportId), "Only AULA report 0x13 is accepted.");
            int requiredLength;
            switch (command)
            {
                case 0x05: requiredLength = 6; break;
                case 0x07: requiredLength = 1; break;
                case 0x44: requiredLength = 128; break;
                case 0x41: requiredLength = 512; break;
                case 0x49: requiredLength = 512; break;
                default: throw new ArgumentOutOfRangeException(nameof(command), "Only AULA query commands 05/07/41/44/49 are accepted; unknown macro pagination is excluded.");
            }
            if (expectedLength != requiredLength && !(command == 0x05 && expectedLength == 10) && !(command == 0x41 && expectedLength == 504) && !(command == 0x49 && expectedLength == 490))
                throw new ArgumentOutOfRangeException(nameof(expectedLength), "This AULA command requires exactly " + requiredLength + " payload bytes.");
            if ((command == 0x41 && selector > 3) || (command != 0x41 && selector != 0))
                throw new ArgumentOutOfRangeException(nameof(selector), "Only matrix query 0x41 accepts selectors 0..3; other allowed queries require zero.");
            if (timeoutMs < 1 || timeoutMs > 30000)
                throw new ArgumentOutOfRangeException(nameof(timeoutMs), "Timeout must be 1..30000 milliseconds.");
            byte[] packet = new byte[AulaReportLength];
            packet[0] = reportId; packet[1] = command; packet[2] = 1; packet[4] = (byte)(selector << 4);
            packet[19] = Checksum(packet);
            return packet;
        }

        private static byte Checksum(byte[] packet)
        {
            int sum = 0;
            for (int i = 0; i < 19; i++) sum += packet[i];
            return unchecked((byte)sum);
        }

        private static int[] AulaResponseLengths(byte command, int expectedLength)
        {
            if (command == 0x41 && expectedLength == 512) return new[] { 504, 512 };
            if (command == 0x49 && expectedLength == 512) return new[] { 490, 512 };
            return new[] { expectedLength };
        }

        private static byte[] ReadAulaBlock(SafeFileHandle handle, byte[] query, byte command, int[] acceptedLengths, Stopwatch clock, int timeoutMs, AulaSnapshotQueryTrace trace = null)
        {
            // Drain stale input before every read attempt, including bounded retries.
            FlushAulaQueue(handle);
            var assembler = new AulaAssembler(AulaReportId, command, acceptedLengths, (byte)(query[4] >> 4));
            Action send = () => Transfer(handle, query, true, Remaining(clock, timeoutMs));
            while (!assembler.Complete)
            {
                byte[] reply = new byte[AulaReportLength];
                try
                {
                    using (var operation = new OverlappedOperation(handle, reply, false))
                        operation.Execute(Remaining(clock, timeoutMs), send);
                }
                catch (TimeoutException error)
                {
                    throw new TimeoutException(error.Message + " " + assembler.IncompleteDescription, error);
                }
                send = null;
                if (trace != null) trace.Record(reply);
                assembler.Append(reply);
            }
            return assembler.Result;
        }

        private const int AulaRetryLimit = 2;
        private static byte[] RunAulaRead(Func<byte[]> read, bool retry, Stopwatch clock, int timeoutMs)
        {
            if (read == null) throw new ArgumentNullException(nameof(read));
            return retry ? RetryAulaRead(read, clock, timeoutMs) : read();
        }

        private static bool RetryableAulaRead(Exception ex)
        {
            for (Exception current = ex; current != null; current = current.InnerException)
            {
                if (current is TimeoutException) return true;
                if (current is InvalidDataException)
                {
                    string message = current.Message ?? string.Empty;
                    if (message.IndexOf("sequence", StringComparison.OrdinalIgnoreCase) >= 0
                        || message.IndexOf("out of order", StringComparison.OrdinalIgnoreCase) >= 0
                        || message.IndexOf("missing", StringComparison.OrdinalIgnoreCase) >= 0
                        || message.IndexOf("command mismatch", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
            }
            return false;
        }

        private static byte[] RetryAulaRead(Func<byte[]> read, Stopwatch clock, int timeoutMs)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { return read(); }
                catch (Exception ex) when (attempt < AulaRetryLimit && RetryableAulaRead(ex))
                {
                    int pause = Math.Min(80, Remaining(clock, timeoutMs));
                    Thread.Sleep(pause);
                }
            }
        }

        private sealed class AulaAssembler
        {
            private readonly byte _reportId, _command, _selector;
            private readonly int[] _acceptedLengths;
            private readonly bool _allowIndexedOrder;
            private int _packetCount, _receivedCount, _targetLength;
            private byte[][] _acceptedPackets;
            public bool Complete { get { return _targetLength > 0 && _packetCount > 0 && _receivedCount == _packetCount; } }
            public string IncompleteDescription
            {
                get
                {
                    var missing = new List<int>();
                    if (_acceptedPackets != null)
                        for (int index = 0; index < _acceptedPackets.Length; index++) if (_acceptedPackets[index] == null) missing.Add(index);
                    return "AULA response received " + _receivedCount + "/" + _packetCount + " fragments; missing indexes="
                        + (_packetCount == 0 ? "unknown" : string.Join(",", missing.ToArray())) + ". No absent bytes were fabricated.";
                }
            }
            public byte[] Result
            {
                get
                {
                    if (!Complete) throw new InvalidOperationException("AULA response is incomplete. " + IncompleteDescription);
                    var result = new byte[_targetLength];
                    for (int index = 0; index < _acceptedPackets.Length; index++)
                    {
                        byte[] packet = _acceptedPackets[index];
                        Buffer.BlockCopy(packet, 5, result, index * 14, packet[4] & 0x0F);
                    }
                    return result;
                }
            }
            public AulaAssembler(byte reportId, byte command, int expectedLength) : this(reportId, command, new[] { expectedLength }, 0) { }
            public AulaAssembler(byte reportId, byte command, int expectedLength, byte selector) : this(reportId, command, new[] { expectedLength }, selector) { }
            public AulaAssembler(byte reportId, byte command, int[] acceptedLengths, byte selector)
            {
                if (acceptedLengths == null || acceptedLengths.Length == 0) throw new ArgumentException("At least one exact response length is required.", nameof(acceptedLengths));
                var lengths = new HashSet<int>();
                foreach (int length in acceptedLengths)
                    if (length < 1 || length > 127 * 14 || !lengths.Add(length)) throw new ArgumentException("AULA response lengths must be unique values in the supported range.", nameof(acceptedLengths));
                _reportId = reportId; _command = command; _selector = selector; _acceptedLengths = (int[])acceptedLengths.Clone();
                // Matrix/palette packets carry an explicit fragment index. A later index may arrive
                // first, but only a complete set from this one query can produce any payload.
                _allowIndexedOrder = command == 0x41 || command == 0x49;
            }
            public void Append(byte[] packet)
            {
                if (Complete) throw new InvalidDataException("AULA reply contains extra packets.");
                if (packet == null || packet.Length != AulaReportLength) throw new InvalidDataException("AULA input packet must be exactly 20 bytes.");
                if (packet[0] != _reportId) throw new InvalidDataException("AULA reply report ID mismatch.");
                if (packet[19] != Checksum(packet)) throw new InvalidDataException("AULA reply checksum mismatch.");
                if ((packet[1] & 0x7F) != _command) throw new InvalidDataException("AULA reply command mismatch; another controller may be using the device.");
                if ((packet[1] & 0x80) != 0 || (packet[2] & 0x80) != 0) throw new InvalidDataException("AULA device returned an error-flagged command reply.");
                int count = packet[2] & 0x7F;
                if (count == 0 || count > 127)
                    throw new InvalidDataException("AULA reply packet count " + count + " is outside the supported 1..127 range.");
                if (_packetCount == 0)
                {
                    bool supportedCount = false;
                    foreach (int length in _acceptedLengths) if ((length + 13) / 14 == count) supportedCount = true;
                    if (!supportedCount) throw new InvalidDataException("AULA reply packet count " + count + " does not match any exact allowed response length.");
                    _packetCount = count;
                    _acceptedPackets = new byte[count][];
                }
                else if (count != _packetCount) throw new InvalidDataException("AULA packet count changed during the response.");
                int index = packet[3];
                if (index >= _packetCount) throw new InvalidDataException("AULA reply fragment index is outside its declared count.");
                if ((packet[4] >> 4) != _selector) throw new InvalidDataException("AULA reply selector does not match the requested layer.");
                if (_acceptedPackets[index] != null)
                {
                    byte[] previous = _acceptedPackets[index];
                    bool same = true;
                    for (int i = 0; i < AulaReportLength; i++) if (previous[i] != packet[i]) { same = false; break; }
                    if (same) return; // Exact repeated wireless packet; no payload is appended twice.
                    throw new InvalidDataException("AULA repeated index has conflicting bytes. Previous=" + BitConverter.ToString(previous) + "; Current=" + BitConverter.ToString(packet));
                }
                if (!_allowIndexedOrder && index != _receivedCount)
                    throw new InvalidDataException("AULA reply packet sequence is missing or out of order. Expected=" + _receivedCount + "; Current=" + BitConverter.ToString(packet));
                int declared = packet[4] & 0x0F;
                bool finalPacket = index + 1 == _packetCount;
                int requiredLength = 14;
                int finalLength = 0;
                if (finalPacket)
                {
                    foreach (int length in _acceptedLengths)
                    {
                        if ((length + 13) / 14 != _packetCount || length - index * 14 != declared) continue;
                        if (finalLength != 0) throw new InvalidDataException("AULA final fragment ambiguously matches multiple allowed response lengths.");
                        finalLength = length;
                    }
                    if (finalLength == 0) throw new InvalidDataException("AULA final fragment length does not match any exact allowed response length.");
                    requiredLength = finalLength - index * 14;
                }
                if (declared != requiredLength)
                    throw new InvalidDataException("AULA payload fragment declares " + declared + " bytes; exact required length is " + requiredLength + ".");
                if (!finalPacket && declared != 14)
                    throw new InvalidDataException("AULA payload fragment ended before the declared final packet.");
                if (finalPacket) _targetLength = finalLength;
                _acceptedPackets[index] = (byte[])packet.Clone();
                _receivedCount++;
            }
        }

        private static int Remaining(Stopwatch clock, int timeoutMs)
        {
            long remaining = timeoutMs - clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException("AULA query timed out; device may be sleeping, disconnected or busy in the original driver application.");
            return (int)remaining;
        }

        private static bool Eq(string a, string b) { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        private static bool IsIn9(HidInterface item)
        {
            return item != null && item.CapsRead && Eq(item.VendorId, "248A") && Eq(item.ProductId, "5B2F")
                && Eq(item.UsagePage, "FF00") && Eq(item.Usage, "0001") && item.FeatureReportBytes == In9ReportLength
                && item.InputReportBytes == 0 && item.OutputReportBytes == 0
                && item.Path != null && item.Path.IndexOf("hid#vid_248a&pid_5b2f&mi_01&col04#", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        private static bool IsAula(HidInterface item)
        {
            return item != null && item.CapsRead && Eq(item.VendorId, "3554") && Eq(item.ProductId, "FA09")
                && Eq(item.UsagePage, "FF02") && Eq(item.Usage, "0002")
                && item.InputReportBytes == AulaReportLength && item.OutputReportBytes == AulaReportLength;
        }
        private static HidInterface FindSingle(bool in9)
        {
            HidInterface selected = null;
            foreach (HidInterface item in ListCandidates())
            {
                if (!(in9 ? IsIn9(item) : IsAula(item))) continue;
                if (selected != null) throw new InvalidOperationException("Multiple matching vendor HID interfaces are present; refusing ambiguous device selection. Disconnect duplicate receivers.");
                selected = item;
            }
            if (selected == null) throw new IOException("Required " + (in9 ? "IN9 248A:5B2F FF00:0001 Feature33" : "AULA 3554:FA09 FF02:0002 Input/Output20") + " interface was not found. Reconnect the matching receiver; other HID collections are not used.");
            return selected;
        }
        private static SafeFileHandle Open(HidInterface target, bool overlapped)
        {
            if (string.IsNullOrWhiteSpace(target.Path)) throw new InvalidDataException("Inventory returned an empty device path.");
            SafeFileHandle handle = CreateFileW(target.Path, GenericRead | GenericWrite, ShareReadWrite, IntPtr.Zero, OpenExisting, overlapped ? FileFlagOverlapped : 0, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                throw NativeFailure("Open vendor HID configuration interface", error);
            }
            return handle;
        }
        private static void VerifyOpenedTarget(SafeFileHandle handle, bool in9)
        {
            var attributes = new HidAttributes { Size = Marshal.SizeOf(typeof(HidAttributes)) };
            if (!HidD_GetAttributes(handle, ref attributes)) throw NativeFailure("HidD_GetAttributes", Marshal.GetLastWin32Error());
            IntPtr parsed;
            if (!HidD_GetPreparsedData(handle, out parsed)) throw NativeFailure("HidD_GetPreparsedData", Marshal.GetLastWin32Error());
            try
            {
                HidCaps caps;
                int status = HidP_GetCaps(parsed, out caps);
                if (status != 0x00110000) throw new IOException("HidP_GetCaps failed: 0x" + status.ToString("X8"));
                bool valid = in9
                    ? attributes.VendorID == 0x248A && attributes.ProductID == 0x5B2F && caps.UsagePage == 0xFF00 && caps.Usage == 1 && caps.FeatureReportByteLength == 33
                    : attributes.VendorID == 0x3554 && attributes.ProductID == 0xFA09 && caps.UsagePage == 0xFF02 && caps.Usage == 2 && caps.InputReportByteLength == 20 && caps.OutputReportByteLength == 20;
                if (!valid) throw new IOException("Opened HID attributes no longer match the exact allowed vendor interface; no query sent.");
            }
            finally { HidD_FreePreparsedData(parsed); }
        }
        private static Exception NativeFailure(string operation, int error)
        {
            return new IOException(operation + " failed (Win32 " + error + "): " + new Win32Exception(error).Message
                + ". The device may be disconnected, busy or exclusively opened by its original application; close that application and retry.", new Win32Exception(error));
        }
        private static void EnsureWindows()
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) throw new PlatformNotSupportedException("Windows HID transport is required.");
        }

        private sealed class DeviceGate : IDisposable
        {
            private readonly Mutex _mutex;
            private bool _owned;
            public DeviceGate(string name, int timeoutMs)
            {
                _mutex = new Mutex(false, @"Local\PeripheralHub.HidConfig." + name);
                try
                {
                    try { _owned = _mutex.WaitOne(timeoutMs); }
                    catch (AbandonedMutexException) { _owned = true; }
                    if (!_owned) throw new TimeoutException("Another PeripheralHub process is using this device; wait for its query to finish and retry.");
                }
                catch { _mutex.Dispose(); throw; }
            }
            public void Dispose()
            {
                try { if (_owned) { _owned = false; _mutex.ReleaseMutex(); } }
                finally { _mutex.Dispose(); }
            }
        }

        private static void Transfer(SafeFileHandle handle, byte[] packet, bool write, int timeoutMs)
        {
            using (var operation = new OverlappedOperation(handle, packet, write)) operation.Execute(timeoutMs);
        }

        /// <summary>Owns unmanaged data, OVERLAPPED and manual-reset event until I/O has completed or cancelled.</summary>
        private sealed class OverlappedOperation : IDisposable
        {
            private readonly SafeFileHandle _handle;
            private readonly byte[] _packet;
            private readonly bool _write;
            private SafeWaitHandle _event;
            private IntPtr _buffer, _overlapped;
            private bool _pending, _disposed;
            public OverlappedOperation(SafeFileHandle handle, byte[] packet, bool write)
            {
                _handle = handle; _packet = packet; _write = write;
                try
                {
                    _event = CreateEventW(IntPtr.Zero, true, false, null);
                    if (_event.IsInvalid) throw NativeFailure("CreateEvent", Marshal.GetLastWin32Error());
                    _buffer = Marshal.AllocHGlobal(packet.Length);
                    Marshal.Copy(packet, 0, _buffer, packet.Length);
                    _overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlappedData)));
                    var native = new NativeOverlappedData { Event = _event.DangerousGetHandle() };
                    Marshal.StructureToPtr(native, _overlapped, false);
                }
                catch { Dispose(); throw; }
            }
            public void Execute(int timeoutMs, Action afterReadArmed = null)
            {
                var clock = Stopwatch.StartNew();
                bool immediate = _write
                    ? WriteFile(_handle, _buffer, (uint)_packet.Length, IntPtr.Zero, _overlapped)
                    : ReadFile(_handle, _buffer, (uint)_packet.Length, IntPtr.Zero, _overlapped);
                if (!immediate)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error != ErrorIoPending) throw NativeFailure(_write ? "AULA WriteFile query" : "AULA ReadFile reply", error);
                    _pending = true;
                    if (afterReadArmed != null) afterReadArmed();
                    uint remaining = (uint)Math.Max(0, timeoutMs - clock.ElapsedMilliseconds);
                    uint wait = WaitForSingleObject(_event, remaining);
                    if (wait == WaitTimeout)
                        throw new TimeoutException("AULA " + (_write ? "query send" : "query response") + " timed out. Device may be sleeping, disconnected or busy in the original application; pending I/O is cancelled and drained before return.");
                    if (wait == WaitFailed) throw NativeFailure("WaitForSingleObject", Marshal.GetLastWin32Error());
                    if (wait != WaitObject0) throw new IOException("Unexpected overlapped wait result: " + wait);
                }
                if (immediate && afterReadArmed != null) afterReadArmed();
                uint transferred;
                bool completed = GetOverlappedResult(_handle, _overlapped, out transferred, false);
                if (!completed)
                {
                    int error = Marshal.GetLastWin32Error();
                    // IO_INCOMPLETE is not terminal; Dispose will cancel and drain it.
                    _pending = error == ErrorIoIncomplete;
                    throw NativeFailure("GetOverlappedResult", error);
                }
                _pending = false;
                if (transferred != _packet.Length) throw new InvalidDataException("HID transfer returned " + transferred + " bytes; exactly " + _packet.Length + " bytes are required.");
                if (!_write) Marshal.Copy(_buffer, _packet, 0, _packet.Length);
            }
            public void Dispose()
            {
                if (_disposed) return;
                _disposed = true;
                if (_pending && _overlapped != IntPtr.Zero)
                {
                    // ERROR_NOT_FOUND from CancelIoEx can mean completion raced cancellation.
                    // Either way GetOverlappedResult(wait:true) is mandatory before releasing memory.
                    CancelIoEx(_handle, _overlapped);
                    uint ignored;
                    while (!GetOverlappedResult(_handle, _overlapped, out ignored, true))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != ErrorIoIncomplete) break; // includes terminal ERROR_OPERATION_ABORTED
                    }
                    _pending = false;
                }
                if (_overlapped != IntPtr.Zero) { Marshal.FreeHGlobal(_overlapped); _overlapped = IntPtr.Zero; }
                if (_buffer != IntPtr.Zero) { Marshal.FreeHGlobal(_buffer); _buffer = IntPtr.Zero; }
                if (_event != null) { _event.Dispose(); _event = null; }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeOverlappedData { public UIntPtr Internal, InternalHigh; public uint Offset, OffsetHigh; public IntPtr Event; }
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
        private static extern bool HidD_SetFeature(SafeFileHandle handle, byte[] buffer, int length);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetFeature(SafeFileHandle handle, [Out] byte[] buffer, int length);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetInputReport(SafeFileHandle handle, [Out] byte[] buffer, int length);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetAttributes(SafeFileHandle handle, ref HidAttributes attributes);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr data);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_FlushQueue(SafeFileHandle handle);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_SetNumInputBuffers(SafeFileHandle handle, uint numberBuffers);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_FreePreparsedData(IntPtr data);
        [DllImport("hid.dll")]
        private static extern int HidP_GetCaps(IntPtr data, out HidCaps caps);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeWaitHandle CreateEventW(IntPtr security, [MarshalAs(UnmanagedType.Bool)] bool manualReset, [MarshalAs(UnmanagedType.Bool)] bool initialState, string name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(SafeFileHandle handle, IntPtr buffer, uint bytes, IntPtr transferred, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(SafeFileHandle handle, IntPtr buffer, uint bytes, IntPtr transferred, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetOverlappedResult(SafeFileHandle handle, IntPtr overlapped, out uint transferred, [MarshalAs(UnmanagedType.Bool)] bool wait);
    }
}
