using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace PeripheralHub
{
    public sealed class WindowsAudioFormat
    {
        public int Channels { get; set; }
        public int BitDepth { get; set; }
        public int SampleRate { get; set; }
        public int FormatTag { get; set; }
        public int ValidBits { get; set; }
        public uint ChannelMask { get; set; }
        public string SubFormat { get; set; }
        public string Encoding { get; set; }
        public int BlockAlign { get; set; }
        public long AverageBytesPerSecond { get; set; }
        public string RawBase64 { get; set; }
    }

    public sealed class WindowsAudioFormatSnapshot
    {
        public string EndpointId { get; set; }
        public string Flow { get; set; }
        public string UsbParentId { get; set; }
        public WindowsAudioFormat DeviceFormat { get; set; }
        public WindowsAudioFormat MixFormat { get; set; }
        public List<string> Errors { get; set; } = new List<string>();
        public string Source { get { return "windows-system"; } }
        public bool SetDefaultFormatVerified { get { return false; } }
    }

    public sealed class WindowsAudioFormatQuery
    {
        public WindowsAudioFormat Format { get; set; }
        public string ShareMode { get { return "exclusive"; } }
        public string Status { get; set; }
        public string HResult { get; set; }
        public bool? Supported { get; set; }
        public string Error { get; set; }
    }

    public sealed class WindowsAudioDefaultOwner
    {
        public string Flow { get; set; }
        public string Role { get; set; }
        public string Status { get; set; }
        public string OwnerEndpointId { get; set; }
        public bool? IsSelectedEndpoint { get; set; }
        public string HResult { get; set; }
        public string Error { get; set; }
    }

    public sealed class WindowsAudioRoleSnapshot
    {
        public string EndpointId { get; set; }
        public string Flow { get; set; }
        public bool Verified { get; set; }
        public string[] Roles { get; set; }
        public WindowsAudioDefaultOwner[] Owners { get; set; }
        public string Source { get { return "windows-system"; } }
        public bool SetDefaultRoleVerified { get { return false; } }
    }

    public sealed class WindowsAudioPolicyChange
    {
        public string EndpointId { get; set; }
        public string Kind { get; set; }
        public string Role { get; set; }
        public string Status { get; set; }
        public WindowsAudioFormat BeforeFormat { get; set; }
        public WindowsAudioFormat RequestedFormat { get; set; }
        public WindowsAudioFormat ActualFormat { get; set; }
        public WindowsAudioFormat RestoredFormat { get; set; }
        public WindowsAudioDefaultOwner[] BeforeOwners { get; set; }
        public WindowsAudioDefaultOwner[] RequestedOwners { get; set; }
        public WindowsAudioDefaultOwner[] ActualOwners { get; set; }
        public WindowsAudioDefaultOwner[] RestoredOwners { get; set; }
        public WindowsAudioRoleWrite[] PlannedRoleWrites { get; set; }
        public int WriteAttempts { get; set; }
        public bool MutationPossible { get; set; }
        public bool RecoveryRequired { get; set; }
        public bool ReadbackVerified { get; set; }
        public bool RestorationVerified { get; set; }
        public bool VendorSdkLoaded { get { return false; } }
        public bool EffectBehaviorVerified { get { return false; } }
        public string Error { get; set; }
        public string RecoveryError { get; set; }
        public string CheckpointError { get; set; }
    }

    public sealed class WindowsAudioRoleWrite
    {
        public string Role { get; set; }
        public string EndpointId { get; set; }
    }

    internal interface IWindowsPolicyActions : IDisposable
    {
        string Flow { get; }
        void AssertTarget();
        WindowsAudioFormat ReadFormat();
        WindowsAudioFormatQuery Query(WindowsAudioFormat format);
        WindowsAudioDefaultOwner[] ReadOwners();
        void ValidateOwner(string endpointId);
        void WriteFormat(WindowsAudioFormat format);
        void WriteOwner(string endpointId, string role);
    }

    // Fixed Core Audio operations and hash-evidenced Windows policy slots. No vendor DLL or registry writes.
    public static class WindowsAudioPolicy
    {
        private const int UnsupportedFormat = unchecked((int)0x88890008);
        private static readonly Guid AudioClientIid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        private static readonly Guid Pcm = new Guid("00000001-0000-0010-8000-00AA00389B71");
        private static readonly Guid Float = new Guid("00000003-0000-0010-8000-00AA00389B71");
        private static readonly PropertyKey DeviceFormatKey = new PropertyKey(new Guid("F19F064D-082C-4E27-BC73-6882A1BB8E4C"), 0);
        private static readonly int[] CandidateChannels = { 1, 2, 4, 6, 8 };
        private static readonly int[] CandidateBits = { 16, 24, 32 };
        private static readonly int[] CandidateRates = { 8000, 11025, 16000, 22050, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000 };

        public static WindowsAudioFormatSnapshot ReadFormats(string endpointId)
        {
            using (var endpoint = new Endpoint(endpointId))
            {
                var result = new WindowsAudioFormatSnapshot { EndpointId = endpointId, Flow = endpoint.Flow, UsbParentId = endpoint.UsbParentId };
                try { result.DeviceFormat = endpoint.ReadDeviceFormat(); } catch (Exception error) { result.Errors.Add("PKEY_AudioEngine_DeviceFormat: " + error.Message); }
                try { result.MixFormat = endpoint.ReadMixFormat(); } catch (Exception error) { result.Errors.Add("IAudioClient.GetMixFormat: " + error.Message); }
                return result;
            }
        }

        public static WindowsAudioFormat ReadDefaultFormat(string endpointId)
        {
            using (var endpoint = new Endpoint(endpointId)) return endpoint.ReadDeviceFormat();
        }

        public static WindowsAudioFormat ReadPolicyDefaultFormat(string endpointId)
        {
            using (var endpoint = new Endpoint(endpointId))
            using (var policy = new PolicyClient()) return policy.ReadFormat(endpointId);
        }

        public static WindowsAudioFormatQuery QueryFormatSupport(string endpointId, int channels, int bitDepth, int sampleRate)
        {
            var candidate = BuildCandidate(channels, bitDepth, sampleRate);
            using (var endpoint = new Endpoint(endpointId)) return endpoint.Query(candidate);
        }

        public static WindowsAudioFormatQuery[] ListFormatSupport(string endpointId)
        {
            using (var endpoint = new Endpoint(endpointId))
            {
                var result = new List<WindowsAudioFormatQuery>();
                foreach (int channels in CandidateChannels) foreach (int bits in CandidateBits) foreach (int rate in CandidateRates) result.Add(endpoint.Query(BuildCandidate(channels, bits, rate)));
                return result.ToArray();
            }
        }

        public static WindowsAudioFormat[] ListFormats(string endpointId)
        {
            var result = new List<WindowsAudioFormat>();
            foreach (var query in ListFormatSupport(endpointId))
            {
                if (!query.Supported.HasValue) throw new InvalidOperationException("A format support query failed (" + query.HResult + "): " + query.Error);
                if (query.Supported.Value) result.Add(query.Format);
            }
            return result.ToArray();
        }

        public static WindowsAudioRoleSnapshot ReadDefaultRoles(string endpointId)
        {
            using (var endpoint = new Endpoint(endpointId))
            {
                var multimedia = ReadRoleOwner(endpoint.Flow, "multimedia");
                var communications = ReadRoleOwner(endpoint.Flow, "communications");
                var roles = new List<string>();
                foreach (var owner in new[] { multimedia, communications })
                {
                    if (owner.Status == "read")
                    {
                        owner.IsSelectedEndpoint = String.Equals(owner.OwnerEndpointId, endpointId, StringComparison.OrdinalIgnoreCase);
                        if (owner.IsSelectedEndpoint.Value) roles.Add(owner.Role);
                    }
                }
                bool verified = multimedia.Status == "read" && communications.Status == "read";
                return new WindowsAudioRoleSnapshot { EndpointId = endpointId, Flow = endpoint.Flow, Owners = new[] { multimedia, communications }, Verified = verified, Roles = verified ? roles.ToArray() : null };
            }
        }

        public static WindowsAudioDefaultOwner ReadRoleOwner(string flow, string role)
        {
            return ReadRoleOwnerCore(flow, RoleValue(role), role);
        }

        public static WindowsAudioDefaultOwner[] ReadAllRoleOwners(string flow)
        {
            return new[] { ReadRoleOwnerCore(flow, 0, "console"), ReadRoleOwner(flow, "multimedia"), ReadRoleOwner(flow, "communications") };
        }

        private static WindowsAudioDefaultOwner ReadRoleOwnerCore(string flow, int nativeRole, string role)
        {
            int nativeFlow = FlowValue(flow);
            EnsureWindows(); IMMDeviceEnumerator enumerator = null; IMMDevice endpoint = null;
            var result = new WindowsAudioDefaultOwner { Flow = flow, Role = role };
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                int hr = enumerator.GetDefaultAudioEndpoint(nativeFlow, nativeRole, out endpoint); result.HResult = "0x" + hr.ToString("X8");
                Check(hr, "IMMDeviceEnumerator.GetDefaultAudioEndpoint");
                Check(endpoint.GetId(out string id), "IMMDevice.GetId"); ValidateId(id);
                int actualFlow; Check(((IMMEndpoint)endpoint).GetDataFlow(out actualFlow), "IMMEndpoint.GetDataFlow");
                if (actualFlow != nativeFlow) throw new InvalidOperationException("Default endpoint direction differs from the requested role flow.");
                result.OwnerEndpointId = id; result.Status = "read";
            }
            catch (Exception error) { result.Status = "unknown"; result.Error = error.Message; }
            finally { Release(endpoint); Release(enumerator); }
            return result;
        }

        public static WindowsAudioPolicyChange SetDefaultFormat(string endpointId, int channels, int bitDepth, int sampleRate, Action<WindowsAudioPolicyChange> checkpoint)
        {
            var requested = BuildCandidate(channels, bitDepth, sampleRate);
            return WithPolicy(endpointId, checkpoint, store => ChangeFormat(endpointId, requested, store, checkpoint));
        }

        public static WindowsAudioPolicyChange ReapplyCurrentDefaultFormat(string endpointId, Action<WindowsAudioPolicyChange> checkpoint)
        {
            return WithPolicy(endpointId, checkpoint, store => ChangeFormat(endpointId, store.ReadFormat(), store, checkpoint, true));
        }

        public static WindowsAudioPolicyChange RestoreDefaultFormat(WindowsAudioPolicyChange applied, Action<WindowsAudioPolicyChange> checkpoint)
        {
            if (applied == null || applied.Kind != "format" || applied.Status != "applied" || !applied.ReadbackVerified || applied.BeforeFormat == null) throw new ArgumentException("A verified applied-format receipt is required.", nameof(applied));
            var desired = ParseFormat(Convert.FromBase64String(applied.BeforeFormat.RawBase64));
            return WithPolicy(applied.EndpointId, checkpoint, store => ChangeFormat(applied.EndpointId, desired, store, checkpoint));
        }

        public static WindowsAudioPolicyChange RestoreDefaultFormatRaw(string endpointId, string exactRawBase64, Action<WindowsAudioPolicyChange> checkpoint)
        {
            if (exactRawBase64 == null || exactRawBase64.Length > 5464) throw new ArgumentException("A bounded exact-before WAVEFORMATEX snapshot is required.", nameof(exactRawBase64));
            var bytes = Convert.FromBase64String(exactRawBase64);
            if (Convert.ToBase64String(bytes) != exactRawBase64) throw new ArgumentException("The format snapshot must use canonical Base64.", nameof(exactRawBase64));
            var desired = ParseFormat(bytes);
            return WithPolicy(endpointId, checkpoint, store => ChangeFormat(endpointId, desired, store, checkpoint));
        }

        public static WindowsAudioPolicyChange SetDefaultRole(string endpointId, string role, Action<WindowsAudioPolicyChange> checkpoint)
        {
            RoleValue(role);
            return WithPolicy(endpointId, checkpoint, store => ChangeRole(endpointId, role, null, store, checkpoint));
        }

        public static WindowsAudioPolicyChange RestoreDefaultRole(WindowsAudioPolicyChange applied, Action<WindowsAudioPolicyChange> checkpoint)
        {
            if (applied == null || applied.Kind != "default-role" || applied.Status != "applied" || !applied.ReadbackVerified) throw new ArgumentException("A verified applied-role receipt is required.", nameof(applied));
            RoleValue(applied.Role);
            return WithPolicy(applied.EndpointId, checkpoint, store => ChangeRole(applied.EndpointId, applied.Role, applied.BeforeOwners, store, checkpoint));
        }

        public static WindowsAudioPolicyChange RestoreDefaultRoles(string endpointId, WindowsAudioDefaultOwner[] exactOwners, Action<WindowsAudioPolicyChange> checkpoint)
        {
            var copied = CloneOwners(ValidatedOwners(exactOwners, endpointId != null && endpointId.StartsWith("{0.0.0.", StringComparison.Ordinal) ? "render" : "capture"));
            return WithPolicy(endpointId, checkpoint, store => ChangeRole(endpointId, "recovery", copied, store, checkpoint));
        }

        private static WindowsAudioPolicyChange WithPolicy(string endpointId, Action<WindowsAudioPolicyChange> checkpoint, Func<IWindowsPolicyActions, WindowsAudioPolicyChange> change)
        {
            ValidateId(endpointId);
            if (checkpoint == null) throw new ArgumentNullException(nameof(checkpoint), "A durable exact-before policy recovery checkpoint is required.");
            EnsureWindows();
            using (var gate = new Mutex(false, "Local\\PeripheralHub.HeadsetAudio"))
            {
                bool owned = false;
                try
                {
                    try { owned = gate.WaitOne(20000); } catch (AbandonedMutexException) { owned = true; }
                    if (!owned) throw new InvalidOperationException("Another headset audio operation is active.");
                    using (var store = new PolicyActions(endpointId)) return change(store);
                }
                finally { if (owned) gate.ReleaseMutex(); }
            }
        }

        internal static WindowsAudioPolicyChange ChangeFormat(string endpointId, WindowsAudioFormat requested, IWindowsPolicyActions store, Action<WindowsAudioPolicyChange> checkpoint, bool reapplyCurrent = false)
        {
            var result = new WindowsAudioPolicyChange { EndpointId = endpointId, Kind = "format", Status = "blocked", RequestedFormat = requested };
            return RunPolicyChange(result, store, checkpoint,
                () =>
                {
                    result.BeforeFormat = store.ReadFormat();
                    if (!FormatMatches(result.BeforeFormat, ParseFormat(Convert.FromBase64String(result.BeforeFormat.RawBase64)))) throw new InvalidOperationException("Default format metadata and exact raw blob disagree.");
                    var support = store.Query(requested);
                    if (support.Supported != true) throw new InvalidOperationException("The exact requested full format is not positively supported: " + support.HResult);
                    return FormatMatches(result.BeforeFormat, requested) && !reapplyCurrent;
                },
                () => { result.WriteAttempts++; store.WriteFormat(requested); },
                () => { result.ActualFormat = store.ReadFormat(); return FormatMatches(result.ActualFormat, requested); },
                () => { result.WriteAttempts++; store.WriteFormat(result.BeforeFormat); result.RestoredFormat = store.ReadFormat(); return FormatMatches(result.RestoredFormat, result.BeforeFormat); });
        }

        internal static WindowsAudioPolicyChange ChangeRole(string endpointId, string role, WindowsAudioDefaultOwner[] restoreOwners, IWindowsPolicyActions store, Action<WindowsAudioPolicyChange> checkpoint)
        {
            var result = new WindowsAudioPolicyChange { EndpointId = endpointId, Kind = "default-role", Role = role, Status = "blocked" };
            return RunPolicyChange(result, store, checkpoint,
                () =>
                {
                    result.BeforeOwners = ValidatedOwners(store.ReadOwners(), store.Flow);
                    result.RequestedOwners = CloneOwners(restoreOwners == null ? result.BeforeOwners : ValidatedOwners(restoreOwners, store.Flow));
                    if (restoreOwners == null)
                    {
                        foreach (var owner in result.RequestedOwners) if (owner.Role == role || (role == "multimedia" && owner.Role == "console")) owner.OwnerEndpointId = endpointId;
                        result.PlannedRoleWrites = new[] { new WindowsAudioRoleWrite { Role = role, EndpointId = endpointId } };
                    }
                    else
                    {
                        var writes = new List<WindowsAudioRoleWrite>();
                        foreach (var owner in result.RequestedOwners)
                        {
                            var before = Array.Find(result.BeforeOwners, value => value.Role == owner.Role);
                            if (!String.Equals(before.OwnerEndpointId, owner.OwnerEndpointId, StringComparison.OrdinalIgnoreCase)) writes.Add(new WindowsAudioRoleWrite { Role = owner.Role, EndpointId = owner.OwnerEndpointId });
                        }
                        result.PlannedRoleWrites = writes.ToArray();
                    }
                    foreach (var owner in result.RequestedOwners) store.ValidateOwner(owner.OwnerEndpointId);
                    return OwnersMatch(result.BeforeOwners, result.RequestedOwners);
                },
                () =>
                {
                    foreach (var write in result.PlannedRoleWrites)
                    {
                        result.WriteAttempts++; store.WriteOwner(write.EndpointId, write.Role);
                    }
                },
                () => { result.ActualOwners = ValidatedOwners(store.ReadOwners(), store.Flow); return OwnersMatch(result.ActualOwners, result.RequestedOwners); },
                () =>
                {
                    foreach (var owner in result.BeforeOwners) store.ValidateOwner(owner.OwnerEndpointId);
                    foreach (var owner in result.BeforeOwners) { result.WriteAttempts++; store.WriteOwner(owner.OwnerEndpointId, owner.Role); }
                    result.RestoredOwners = ValidatedOwners(store.ReadOwners(), store.Flow); return OwnersMatch(result.RestoredOwners, result.BeforeOwners);
                });
        }

        private static WindowsAudioPolicyChange RunPolicyChange(WindowsAudioPolicyChange result, IWindowsPolicyActions store, Action<WindowsAudioPolicyChange> checkpoint, Func<bool> prepare, Action write, Func<bool> verify, Func<bool> restore)
        {
            bool saved = false;
            try
            {
                store.AssertTarget();
                if (prepare()) { result.Status = "unchanged"; result.ReadbackVerified = true; result.ActualFormat = result.BeforeFormat; result.ActualOwners = result.BeforeOwners; return result; }
                result.Status = "prepared"; result.RecoveryRequired = true; checkpoint(result); saved = true;
                store.AssertTarget(); result.MutationPossible = true; write();
                store.AssertTarget(); if (!verify()) throw new InvalidOperationException("Windows policy readback differs from the complete requested state.");
                result.Status = "applied"; result.ReadbackVerified = true; result.RecoveryRequired = false; checkpoint(result);
            }
            catch (Exception error)
            {
                result.Error = error.Message;
                if (result.MutationPossible)
                {
                    result.Status = "restoring"; result.RecoveryRequired = true;
                    try { checkpoint(result); } catch (Exception journalError) { result.CheckpointError = journalError.Message; }
                    try
                    {
                        store.AssertTarget(); if (!restore()) throw new InvalidOperationException("Windows policy recovery readback differs from the exact before state.");
                        result.Status = "restored-after-failure"; result.RestorationVerified = true; result.RecoveryRequired = false;
                    }
                    catch (Exception restoreError) { result.Status = "recovery-required"; result.RecoveryError = restoreError.Message; }
                }
                else { result.Status = "blocked"; result.RecoveryRequired = false; }
                if (saved) try { checkpoint(result); } catch (Exception journalError) { result.CheckpointError = journalError.Message; result.Status = "recovery-record-pending"; result.RecoveryRequired = true; }
            }
            return result;
        }

        internal static bool FormatMatches(WindowsAudioFormat left, WindowsAudioFormat right)
        {
            return left != null && right != null && left.RawBase64 == right.RawBase64 && left.Channels == right.Channels && left.BitDepth == right.BitDepth && left.SampleRate == right.SampleRate && left.ValidBits == right.ValidBits && left.ChannelMask == right.ChannelMask && left.SubFormat == right.SubFormat;
        }

        private static WindowsAudioDefaultOwner[] ValidatedOwners(WindowsAudioDefaultOwner[] owners, string flow)
        {
            if (owners == null || owners.Length != 3) throw new InvalidOperationException("All three exact Windows role owners are required for recovery.");
            var seen = new HashSet<string>();
            foreach (var owner in owners)
            {
                if (owner == null || owner.Flow != flow || owner.Status != "read" || (owner.Role != "console" && owner.Role != "multimedia" && owner.Role != "communications") || !seen.Add(owner.Role)) throw new InvalidOperationException("Default role owners are missing, unknown or ambiguous.");
                ValidateId(owner.OwnerEndpointId);
            }
            return owners;
        }

        private static WindowsAudioDefaultOwner[] CloneOwners(WindowsAudioDefaultOwner[] owners)
        {
            return Array.ConvertAll(owners, owner => new WindowsAudioDefaultOwner { Flow = owner.Flow, Role = owner.Role, Status = "read", OwnerEndpointId = owner.OwnerEndpointId });
        }

        internal static bool OwnersMatch(WindowsAudioDefaultOwner[] actual, WindowsAudioDefaultOwner[] expected)
        {
            if (actual == null || expected == null || actual.Length != 3 || expected.Length != 3) return false;
            foreach (var owner in expected)
            {
                var matches = Array.FindAll(actual, value => value.Role == owner.Role && value.Flow == owner.Flow && value.Status == "read");
                if (matches.Length != 1 || !String.Equals(matches[0].OwnerEndpointId, owner.OwnerEndpointId, StringComparison.OrdinalIgnoreCase)) return false;
            }
            return true;
        }

        internal static int FlowValue(string flow) { if (flow == "render") return 0; if (flow == "capture") return 1; throw new ArgumentException("Flow must be render or capture.", nameof(flow)); }
        internal static int RoleValue(string role) { if (role == "multimedia") return 1; if (role == "communications") return 2; throw new ArgumentException("Only Windows multimedia/communications roles are exposed.", nameof(role)); }

        internal static WindowsAudioFormat ParseFormat(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 18 || bytes.Length > 4096) throw new InvalidOperationException("WAVEFORMATEX must contain 18..4096 exact bytes.");
            int tag = BitConverter.ToUInt16(bytes, 0), channels = BitConverter.ToUInt16(bytes, 2), rate = checked((int)BitConverter.ToUInt32(bytes, 4));
            uint average = BitConverter.ToUInt32(bytes, 8); int align = BitConverter.ToUInt16(bytes, 12), bits = BitConverter.ToUInt16(bytes, 14), extension = BitConverter.ToUInt16(bytes, 16);
            if (bytes.Length != 18 + extension || channels <= 0 || channels > 256 || rate <= 0 || bits <= 0 || bits > 64 || align <= 0 || average <= 0) throw new InvalidOperationException("Invalid or inconsistent WAVEFORMATEX size/fields.");
            Guid subFormat = tag == 1 ? Pcm : tag == 3 ? Float : Guid.Empty;
            int validBits = bits; uint mask = 0;
            if (tag == 0xFFFE)
            {
                if (extension < 22) throw new InvalidOperationException("WAVEFORMATEXTENSIBLE requires a 22-byte extension.");
                validBits = BitConverter.ToUInt16(bytes, 18); mask = BitConverter.ToUInt32(bytes, 20);
                var guidBytes = new byte[16]; Array.Copy(bytes, 24, guidBytes, 0, 16); subFormat = new Guid(guidBytes);
                if (validBits <= 0 || validBits > bits) throw new InvalidOperationException("Invalid sample precision in WAVEFORMATEXTENSIBLE.");
            }
            string encoding = subFormat == Pcm ? "pcm-integer" : subFormat == Float ? "ieee-float" : "unknown";
            if (encoding == "unknown") throw new InvalidOperationException("This diagnostic only interprets PCM integer and IEEE float formats.");
            if (bits % 8 != 0 || align != channels * (bits / 8) || average != (long)align * rate) throw new InvalidOperationException("PCM/float block alignment or byte rate is inconsistent.");
            return new WindowsAudioFormat { Channels = channels, BitDepth = bits, SampleRate = rate, FormatTag = tag, ValidBits = validBits, ChannelMask = mask, SubFormat = subFormat.ToString("D"), Encoding = encoding, BlockAlign = align, AverageBytesPerSecond = average, RawBase64 = Convert.ToBase64String(bytes) };
        }

        internal static WindowsAudioFormat BuildCandidate(int channels, int bits, int rate)
        {
            if (Array.IndexOf(CandidateChannels, channels) < 0 || Array.IndexOf(CandidateBits, bits) < 0 || Array.IndexOf(CandidateRates, rate) < 0) throw new ArgumentException("Only the fixed 180 candidate tuples may be queried.");
            uint mask = channels == 1 ? 0x4u : channels == 2 ? 0x3u : channels == 4 ? 0x33u : channels == 6 ? 0x60Fu : 0x63Fu;
            var bytes = new byte[40];
            Copy(bytes, 0, BitConverter.GetBytes((ushort)0xFFFE)); Copy(bytes, 2, BitConverter.GetBytes((ushort)channels)); Copy(bytes, 4, BitConverter.GetBytes((uint)rate));
            ushort align = checked((ushort)(channels * (bits / 8)));
            Copy(bytes, 8, BitConverter.GetBytes(checked((uint)(align * rate)))); Copy(bytes, 12, BitConverter.GetBytes(align)); Copy(bytes, 14, BitConverter.GetBytes((ushort)bits));
            Copy(bytes, 16, BitConverter.GetBytes((ushort)22)); Copy(bytes, 18, BitConverter.GetBytes((ushort)bits)); Copy(bytes, 20, BitConverter.GetBytes(mask)); Copy(bytes, 24, Pcm.ToByteArray());
            return ParseFormat(bytes);
        }

        internal static WindowsAudioFormatQuery InterpretQuery(WindowsAudioFormat format, int hr)
        {
            var result = new WindowsAudioFormatQuery { Format = format, HResult = "0x" + hr.ToString("X8") };
            if (hr == 0) { result.Status = "supported"; result.Supported = true; }
            else if (hr == UnsupportedFormat) { result.Status = "unsupported"; result.Supported = false; }
            else { result.Status = "query-error"; result.Error = hr < 0 ? Marshal.GetExceptionForHR(hr).Message : "Unexpected HRESULT for an exclusive-mode exact-format query."; }
            return result;
        }

        private static void Copy(byte[] destination, int offset, byte[] value) { Array.Copy(value, 0, destination, offset, value.Length); }
        private static void ValidateId(string id) { if (id == null || !Regex.IsMatch(id, @"^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$")) throw new ArgumentException("An exact Windows audio endpoint ID is required.", nameof(id)); }
        private static void EnsureWindows() { if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || !Environment.Is64BitProcess) throw new PlatformNotSupportedException("Windows x64 Core Audio is required."); }
        private static void Check(int hr, string operation) { if (hr < 0) throw new COMException(operation + " failed (0x" + hr.ToString("X8") + ").", hr); }
        private static void CheckCr(uint cr) { if (cr != 0) throw new InvalidOperationException("Exact target PnP identity lookup failed (CONFIGRET 0x" + cr.ToString("X8") + ")."); }
        private static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }

        private sealed class PolicyClient : IDisposable
        {
            private IntPtr instance;
            private readonly PolicyGetFormat getFormat;
            private readonly PolicySetFormat setFormat;
            private readonly PolicySetOwner setOwner;
            public PolicyClient()
            {
                Guid clsid = new Guid("294935CE-F637-4E7C-A41B-AB255460B862"), iid = new Guid("568B9108-44BF-40B4-9006-86AFE5B5A620");
                Check(CoCreateInstance(ref clsid, IntPtr.Zero, 23, ref iid, out instance), "CoCreateInstance(IPolicyConfigVista)");
                // Matching CmXearSDK SHA256 evidence: Get 0x3ECE8, Set 0x40183, role 0x422F4.
                try
                {
                    getFormat = Marshal.GetDelegateForFunctionPointer<PolicyGetFormat>(Slot(0x20));
                    setFormat = Marshal.GetDelegateForFunctionPointer<PolicySetFormat>(Slot(0x28));
                    setOwner = Marshal.GetDelegateForFunctionPointer<PolicySetOwner>(Slot(0x60));
                }
                catch { Dispose(); throw; }
            }
            private IntPtr Slot(int offset)
            {
                if (instance == IntPtr.Zero) throw new ObjectDisposedException(nameof(PolicyClient));
                IntPtr address = Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), offset);
                if (address == IntPtr.Zero) throw new InvalidOperationException("The evidenced Windows policy vtable slot is unavailable.");
                return address;
            }
            public WindowsAudioFormat ReadFormat(string id)
            {
                IntPtr pointer = IntPtr.Zero;
                try
                {
                    Check(getFormat(instance, id, 0, out pointer), "Windows policy GetDeviceFormat");
                    if (pointer == IntPtr.Zero) throw new InvalidOperationException("Windows policy returned no device format.");
                    int extension = unchecked((ushort)Marshal.ReadInt16(pointer, 16));
                    if (extension > 4078) throw new InvalidOperationException("Windows policy format extension is too large.");
                    var bytes = new byte[18 + extension]; Marshal.Copy(pointer, bytes, 0, bytes.Length); return ParseFormat(bytes);
                }
                finally { if (pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pointer); }
            }
            public void WriteFormat(string id, WindowsAudioFormat format)
            {
                var bytes = Convert.FromBase64String(format.RawBase64); ParseFormat(bytes);
                IntPtr pointer = Marshal.AllocCoTaskMem(bytes.Length);
                try { Marshal.Copy(bytes, 0, pointer, bytes.Length); Check(setFormat(instance, id, pointer, IntPtr.Zero), "Windows policy SetDeviceFormat"); }
                finally { Marshal.FreeCoTaskMem(pointer); }
            }
            public void WriteOwner(string id, string role)
            {
                int value = role == "console" ? 0 : RoleValue(role);
                Check(setOwner(instance, id, value), "Windows policy SetDefaultEndpoint");
            }
            public void Dispose() { if (instance != IntPtr.Zero) { Marshal.Release(instance); instance = IntPtr.Zero; } }
        }

        private sealed class PolicyActions : IWindowsPolicyActions
        {
            private readonly string endpointId;
            private Endpoint endpoint;
            private PolicyClient policy;
            public string Flow { get { return endpoint.Flow; } }
            public PolicyActions(string id)
            {
                endpointId = id;
                try { endpoint = new Endpoint(id); policy = new PolicyClient(); }
                catch { Dispose(); throw; }
            }
            public void AssertTarget() { using (var current = new Endpoint(endpointId)) { if (current.Flow != Flow) throw new InvalidOperationException("The current physical endpoint direction changed."); } }
            public WindowsAudioFormat ReadFormat() { return policy.ReadFormat(endpointId); }
            public WindowsAudioFormatQuery Query(WindowsAudioFormat format) { return endpoint.Query(format); }
            public WindowsAudioDefaultOwner[] ReadOwners() { return ReadAllRoleOwners(Flow); }
            public void ValidateOwner(string id)
            {
                ValidateId(id); IMMDeviceEnumerator enumerator = null; IMMDevice owner = null;
                try
                {
                    enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); Check(enumerator.GetDevice(id, out owner), "IMMDeviceEnumerator.GetDevice(saved role owner)");
                    uint state; Check(owner.GetState(out state), "IMMDevice.GetState(saved role owner)");
                    int flow; Check(((IMMEndpoint)owner).GetDataFlow(out flow), "IMMEndpoint.GetDataFlow(saved role owner)");
                    if ((state & 1) == 0 || flow != FlowValue(Flow)) throw new InvalidOperationException("The saved Windows default role owner is unavailable or belongs to a different flow.");
                }
                finally { Release(owner); Release(enumerator); }
            }
            public void WriteFormat(WindowsAudioFormat format) { policy.WriteFormat(endpointId, format); }
            public void WriteOwner(string id, string role) { policy.WriteOwner(id, role); }
            public void Dispose() { if (policy != null) { policy.Dispose(); policy = null; } if (endpoint != null) { endpoint.Dispose(); endpoint = null; } }
        }

        private sealed class Endpoint : IDisposable
        {
            private IMMDeviceEnumerator enumerator; private IMMDevice device; private object audioClientOwner; private IAudioClientRead audioClient;
            public string Flow { get; private set; }
            public string UsbParentId { get; private set; }
            public Endpoint(string id)
            {
                ValidateId(id); EnsureWindows();
                try
                {
                    enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject(); Check(enumerator.GetDevice(id, out device), "IMMDeviceEnumerator.GetDevice");
                    uint state; Check(device.GetState(out state), "IMMDevice.GetState"); if ((state & 1) == 0) throw new InvalidOperationException("The target endpoint is not active.");
                    int flow; Check(((IMMEndpoint)device).GetDataFlow(out flow), "IMMEndpoint.GetDataFlow"); Flow = flow == 0 ? "render" : flow == 1 ? "capture" : throw new InvalidOperationException("Invalid audio flow.");
                    if ((flow == 0) != id.StartsWith("{0.0.0.", StringComparison.Ordinal)) throw new InvalidOperationException("Endpoint ID and audio flow disagree.");
                    uint node; CheckCr(CM_Locate_DevNodeW(out node, "SWD\\MMDEVAPI\\" + id, 0));
                    bool found = false;
                    for (int depth = 0; depth < 12; depth++)
                    {
                        var nodeId = new StringBuilder(512); CheckCr(CM_Get_Device_IDW(node, nodeId, nodeId.Capacity, 0)); string instance = nodeId.ToString();
                        if (Regex.IsMatch(instance, @"^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}&MI_[0-9A-F]{2}\\", RegexOptions.IgnoreCase))
                        {
                            if (!Regex.IsMatch(instance, @"^USB\\VID_0E6A&PID_0110&MI_00\\[^\\]+$", RegexOptions.IgnoreCase)) throw new InvalidOperationException("Endpoint belongs to a different USB interface.");
                            uint parent; CheckCr(CM_Get_Parent(out parent, node, 0)); var parentId = new StringBuilder(512); CheckCr(CM_Get_Device_IDW(parent, parentId, parentId.Capacity, 0)); UsbParentId = parentId.ToString();
                            if (!Regex.IsMatch(UsbParentId, @"\AUSB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+\z", RegexOptions.IgnoreCase)) throw new InvalidOperationException("Endpoint does not belong to the target USB headset model.");
                            found = true; break;
                        }
                        uint next; CheckCr(CM_Get_Parent(out next, node, 0)); node = next;
                    }
                    if (!found) throw new InvalidOperationException("The exact physical USB headset was not found.");
                }
                catch { Dispose(); throw; }
            }
            private IAudioClientRead Client
            {
                get
                {
                    if (audioClient == null)
                    {
                        Guid iid = AudioClientIid; Check(device.Activate(ref iid, 1, IntPtr.Zero, out audioClientOwner), "IMMDevice.Activate(IAudioClient)"); audioClient = (IAudioClientRead)audioClientOwner;
                    }
                    return audioClient;
                }
            }
            public WindowsAudioFormat ReadDeviceFormat()
            {
                IPropertyStoreRead store = null; PropVariant value = default(PropVariant);
                try
                {
                    Check(device.OpenPropertyStore(0, out store), "IMMDevice.OpenPropertyStore(STGM_READ)"); var key = DeviceFormatKey; Check(store.GetValue(ref key, out value), "PKEY_AudioEngine_DeviceFormat");
                    if (value.Type != 65 || value.Count < 18 || value.Count > 4096 || value.BlobPointer == IntPtr.Zero) throw new InvalidOperationException("Device default format is not a bounded VT_BLOB WAVEFORMATEX.");
                    var bytes = new byte[value.Count]; Marshal.Copy(value.BlobPointer, bytes, 0, bytes.Length); return ParseFormat(bytes);
                }
                finally { PropVariantClear(ref value); Release(store); }
            }
            public WindowsAudioFormat ReadMixFormat()
            {
                IntPtr pointer = IntPtr.Zero;
                try
                {
                    Check(Client.GetMixFormat(out pointer), "IAudioClient.GetMixFormat"); if (pointer == IntPtr.Zero) throw new InvalidOperationException("Windows returned no mix format.");
                    int extension = unchecked((ushort)Marshal.ReadInt16(pointer, 16)); if (extension > 4078) throw new InvalidOperationException("Mix format extension is too large.");
                    var bytes = new byte[18 + extension]; Marshal.Copy(pointer, bytes, 0, bytes.Length); return ParseFormat(bytes);
                }
                finally { if (pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pointer); }
            }
            public WindowsAudioFormatQuery Query(WindowsAudioFormat candidate)
            {
                var bytes = Convert.FromBase64String(candidate.RawBase64); IntPtr pointer = Marshal.AllocCoTaskMem(bytes.Length);
                try { Marshal.Copy(bytes, 0, pointer, bytes.Length); return InterpretQuery(candidate, Client.IsFormatSupported(1, pointer, IntPtr.Zero)); }
                finally { Marshal.FreeCoTaskMem(pointer); }
            }
            public void Dispose() { audioClient = null; Release(audioClientOwner); audioClientOwner = null; Release(device); device = null; Release(enumerator); enumerator = null; }
        }

        [StructLayout(LayoutKind.Sequential)] private struct PropertyKey { public Guid Format; public uint Id; public PropertyKey(Guid format, uint id) { Format = format; Id = id; } }
        [StructLayout(LayoutKind.Explicit, Size = 24)] private struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public int Count; [FieldOffset(16)] public IntPtr BlobPointer; }
        [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
        [DllImport("ole32.dll", ExactSpelling = true)] private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint clsctx, ref Guid iid, out IntPtr instance);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int PolicyGetFormat(IntPtr instance, [MarshalAs(UnmanagedType.LPWStr)] string endpointId, int flag, out IntPtr waveFormat);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int PolicySetFormat(IntPtr instance, [MarshalAs(UnmanagedType.LPWStr)] string endpointId, IntPtr deviceFormat, IntPtr mixFormat);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int PolicySetOwner(IntPtr instance, [MarshalAs(UnmanagedType.LPWStr)] string endpointId, int windowsRole);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Locate_DevNodeW(out uint node, string id, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Get_Device_IDW(uint node, StringBuilder buffer, int length, uint flags);
        [DllImport("cfgmgr32.dll", ExactSpelling = true)] private static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] private class MMDeviceEnumeratorComObject { }
        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice endpoint);
            [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
        }
        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, uint clsctx, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object result);
            [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStoreRead store);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out uint state);
        }
        [ComImport, Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IMMEndpoint { [PreserveSig] int GetDataFlow(out int flow); }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IPropertyStoreRead
        {
            [PreserveSig] int GetCount(out uint count); [PreserveSig] int GetAt(uint index, out PropertyKey key); [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        }
        [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IAudioClientRead
        {
            [PreserveSig] int Initialize(int shareMode, uint flags, long duration, long periodicity, IntPtr format, IntPtr sessionGuid);
            [PreserveSig] int GetBufferSize(out uint frames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint frames);
            [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
            [PreserveSig] int GetMixFormat(out IntPtr format);
        }
    }
}
