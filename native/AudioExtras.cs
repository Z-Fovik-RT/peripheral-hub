using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace PeripheralHub
{
    /// <summary>Per-channel endpoint scalar volume. Levels are in the inclusive range 0..1.</summary>
    public sealed class AudioChannels
    {
        public string Id { get; private set; }
        public float[] Levels { get; private set; }

        internal AudioChannels(string id, float[] levels)
        {
            Id = id;
            Levels = levels ?? throw new ArgumentNullException(nameof(levels));
        }
    }

    /// <summary>One Core Audio session snapshot. Volume is a percentage in the inclusive range 0..100.</summary>
    public sealed class AudioSessionInfo
    {
        public string InstanceId { get; private set; }
        public string SessionId { get; private set; }
        public uint ProcessId { get; private set; }
        public string Description { get; private set; }
        public bool Active { get; private set; }
        public float Volume { get; private set; }
        public bool Muted { get; private set; }

        internal AudioSessionInfo(string instanceId, string sessionId, uint processId,
            string description, bool active, float volume, bool muted)
        {
            InstanceId = instanceId;
            SessionId = sessionId;
            ProcessId = processId;
            Description = description ?? string.Empty;
            Active = active;
            Volume = volume;
            Muted = muted;
        }
    }

    /// <summary>
    /// Independent Windows Core Audio helpers for channel volumes, endpoint peaks, and sessions.
    /// Endpoint IDs are always opened explicitly; no default-device fallback is performed.
    /// </summary>
    public static class AudioExtras
    {
        private const uint DeviceStateActive = 0x00000001;
        private const uint ClsctxAll = 0x00000017;
        private static readonly Guid EndpointVolumeIid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        private static readonly Guid MeterInformationIid = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
        private static readonly Guid SessionManager2Iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        private static readonly Guid ChangeContext = new Guid("C0729F59-3C04-49DD-9C19-1FB5582F2069");

        public static AudioChannels GetChannels(string id)
        {
            ValidateId(id);
            EnsureWindows();
            using (var endpoint = Open(id))
            {
                return endpoint.ReadChannels();
            }
        }

        public static AudioChannels SetChannels(string id, float[] levels)
        {
            ValidateId(id);
            if (levels == null)
                throw new ArgumentNullException(nameof(levels));
            var requested = (float[])levels.Clone();
            ValidateLevels(requested);
            EnsureWindows();
            using (var endpoint = Open(id))
            {
                var before = endpoint.ReadChannels();
                if (before.Levels.Length != requested.Length)
                    throw new ArgumentException("The supplied channel count does not match the endpoint.", nameof(levels));
                try
                {
                    endpoint.WriteChannels(requested);
                    var actual = endpoint.ReadChannels();
                    EnsureEqual(actual.Levels, requested, "Audio channel readback differs from the requested state.");
                    return actual;
                }
                catch (Exception applyError)
                {
                    try
                    {
                        endpoint.WriteChannels(before.Levels);
                        var restored = endpoint.ReadChannels();
                        EnsureEqual(restored.Levels, before.Levels,
                            "Audio channel recovery readback differs from its baseline.");
                    }
                    catch (Exception recoveryError)
                    {
                        throw new AggregateException(
                            "Audio channel apply failed and recovery needs retry. The saved baseline must be retained.",
                            applyError, recoveryError);
                    }
                    throw new InvalidOperationException(
                        "Audio channel apply failed; the immediately previous state was restored and verified.",
                        applyError);
                }
            }
        }

        public static float[] GetPeaks(string id)
        {
            ValidateId(id);
            EnsureWindows();
            using (var endpoint = Open(id))
            {
                return endpoint.ReadPeaks();
            }
        }

        public static List<AudioSessionInfo> ListSessions(string id)
        {
            ValidateId(id);
            EnsureWindows();
            using (var endpoint = Open(id))
            {
                return endpoint.ReadSessions();
            }
        }

        /// <summary>
        /// Updates the session identified by its exact instance identifier. Volume is a percentage.
        /// Any readback mismatch restores both fields to their immediately previous values.
        /// </summary>
        public static AudioSessionInfo SetSession(string id, string sessionId, float? volumePercent, bool? muted)
        {
            ValidateId(id);
            ValidateSessionId(sessionId);
            if (!volumePercent.HasValue && !muted.HasValue)
                throw new ArgumentException("Supply volumePercent, muted, or both.");
            if (volumePercent.HasValue &&
                (float.IsNaN(volumePercent.Value) || float.IsInfinity(volumePercent.Value)
                    || volumePercent.Value < 0.0f || volumePercent.Value > 100.0f))
                throw new ArgumentOutOfRangeException(nameof(volumePercent), volumePercent,
                    "Volume must be a finite number between 0 and 100 inclusive.");

            EnsureWindows();
            using (var endpoint = Open(id))
            {
                using (var session = endpoint.FindSession(sessionId))
                {
                    var before = session.ReadInfo();
                    try
                    {
                        session.Write(volumePercent, muted);
                        var actual = session.ReadInfo();
                        if ((volumePercent.HasValue && Math.Abs(actual.Volume - volumePercent.Value) > 0.5f)
                            || (muted.HasValue && actual.Muted != muted.Value))
                            throw new InvalidOperationException("Audio session readback differs from the requested state.");
                        return actual;
                    }
                    catch (Exception applyError)
                    {
                        try
                        {
                            session.Write(before.Volume, before.Muted);
                            var restored = session.ReadInfo();
                            if (Math.Abs(restored.Volume - before.Volume) > 0.5f
                                || restored.Muted != before.Muted)
                                throw new InvalidOperationException(
                                    "Audio session recovery readback differs from its baseline.");
                        }
                        catch (Exception recoveryError)
                        {
                            throw new AggregateException(
                                "Audio session apply failed and recovery needs retry. The saved baseline must be retained.",
                                applyError, recoveryError);
                        }
                        throw new InvalidOperationException(
                            "Audio session apply failed; the immediately previous state was restored and verified.",
                            applyError);
                    }
                }
            }
        }

        private static EndpointHandle Open(string id)
        {
            using (var enumerator = new EnumeratorHandle())
            {
                return enumerator.OpenDetached(id);
            }
        }

        private static void ValidateId(string id)
        {
            if (string.IsNullOrWhiteSpace(id) || id.IndexOf('\0') >= 0)
                throw new ArgumentException("A complete endpoint ID without embedded NUL characters is required.", nameof(id));
        }

        private static void ValidateSessionId(string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || sessionId.IndexOf('\0') >= 0)
                throw new ArgumentException("A complete session instance ID without embedded NUL characters is required.", nameof(sessionId));
        }

        private static void ValidateLevels(float[] levels)
        {
            if (levels == null)
                throw new ArgumentNullException(nameof(levels));
            if (levels.Length == 0 || levels.Length > 256)
                throw new ArgumentOutOfRangeException(nameof(levels), "Channel count must be between 1 and 256.");
            foreach (var level in levels)
                if (float.IsNaN(level) || float.IsInfinity(level) || level < 0.0f || level > 1.0f)
                    throw new ArgumentOutOfRangeException(nameof(levels),
                        "Every channel level must be a finite number between 0 and 1 inclusive.");
        }

        private static void EnsureEqual(float[] actual, float[] expected, string message)
        {
            if (actual == null || expected == null || actual.Length != expected.Length)
                throw new InvalidOperationException(message);
            for (int i = 0; i < actual.Length; i++)
                if (float.IsNaN(actual[i]) || float.IsInfinity(actual[i])
                    || Math.Abs(actual[i] - expected[i]) > 0.001f)
                    throw new InvalidOperationException(message);
        }

        private static void EnsureWindows()
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                throw new PlatformNotSupportedException("Windows Core Audio is required.");
        }

        private static void Check(int hr, string operation)
        {
            if (hr < 0)
            {
                Exception cause = Marshal.GetExceptionForHR(hr);
                throw new COMException(operation + " failed (HRESULT 0x" + hr.ToString("X8") + "): "
                    + (cause == null ? "Unknown COM error." : cause.Message), hr);
            }
        }

        // Each returned COM interface is an owned RCW. Interface casts on the same RCW are borrowed aliases.
        private static void ReleaseCom<T>(ref T instance) where T : class
        {
            T owned = instance;
            instance = null;
            if (owned != null && Marshal.IsComObject(owned))
                Marshal.ReleaseComObject(owned);
        }

        private sealed class EnumeratorHandle : IDisposable
        {
            private IMMDeviceEnumerator _instance;

            public EnumeratorHandle()
            {
                object activated = new MMDeviceEnumeratorComObject();
                try
                {
                    _instance = (IMMDeviceEnumerator)activated;
                    activated = null;
                }
                finally
                {
                    ReleaseCom(ref activated);
                }
            }

            public EndpointHandle OpenDetached(string id)
            {
                IMMDevice device = null;
                try
                {
                    Check(_instance.GetDevice(id, out device), "IMMDeviceEnumerator.GetDevice");
                    var endpoint = new EndpointHandle(device, id);
                    device = null;
                    return endpoint;
                }
                finally
                {
                    ReleaseCom(ref device);
                }
            }

            public void Dispose()
            {
                ReleaseCom(ref _instance);
            }
        }

        private sealed class EndpointHandle : IDisposable
        {
            private IMMDevice _device;
            private readonly string _id;
            private IAudioEndpointVolume _volume;
            private IAudioMeterInformation _meter;
            private IAudioSessionManager2 _sessions;

            public EndpointHandle(IMMDevice device, string id)
            {
                _device = device ?? throw new ArgumentNullException(nameof(device));
                _id = id;
                uint state;
                Check(_device.GetState(out state), "IMMDevice.GetState");
                if ((state & DeviceStateActive) == 0)
                    throw new InvalidOperationException("The requested audio endpoint is not active.");
                string actualId;
                Check(_device.GetId(out actualId), "IMMDevice.GetId");
                if (!string.Equals(actualId, id, StringComparison.Ordinal))
                    throw new InvalidOperationException("The opened endpoint ID differs from the requested endpoint.");
            }

            private T Activate<T>(ref T field, Guid iid, string operation) where T : class
            {
                if (field == null)
                {
                    object activated = null;
                    try
                    {
                        Guid requested = iid;
                        Check(_device.Activate(ref requested, ClsctxAll, IntPtr.Zero, out activated), operation);
                        field = (T)activated;
                        activated = null;
                    }
                    finally
                    {
                        ReleaseCom(ref activated);
                    }
                }
                return field;
            }

            private IAudioEndpointVolume Volume
            {
                get { return Activate(ref _volume, EndpointVolumeIid, "IMMDevice.Activate(IAudioEndpointVolume)"); }
            }

            private IAudioMeterInformation Meter
            {
                get { return Activate(ref _meter, MeterInformationIid, "IMMDevice.Activate(IAudioMeterInformation)"); }
            }

            private IAudioSessionManager2 SessionManager
            {
                get { return Activate(ref _sessions, SessionManager2Iid, "IMMDevice.Activate(IAudioSessionManager2)"); }
            }

            public AudioChannels ReadChannels()
            {
                uint count;
                Check(Volume.GetChannelCount(out count), "IAudioEndpointVolume.GetChannelCount");
                if (count == 0 || count > 256)
                    throw new InvalidOperationException("The audio driver returned an invalid channel count.");
                var values = new float[count];
                for (uint i = 0; i < count; i++)
                {
                    float value;
                    Check(Volume.GetChannelVolumeLevelScalar(i, out value),
                        "IAudioEndpointVolume.GetChannelVolumeLevelScalar");
                    if (float.IsNaN(value) || float.IsInfinity(value) || value < 0.0f || value > 1.0f)
                        throw new InvalidOperationException("The audio driver returned an invalid channel scalar.");
                    values[i] = value;
                }
                return new AudioChannels(_id, values);
            }

            public void WriteChannels(float[] values)
            {
                Guid context = ChangeContext;
                for (uint i = 0; i < values.Length; i++)
                    Check(Volume.SetChannelVolumeLevelScalar(i, values[i], ref context),
                        "IAudioEndpointVolume.SetChannelVolumeLevelScalar");
            }

            public float[] ReadPeaks()
            {
                uint count;
                Check(Meter.GetMeteringChannelCount(out count),
                    "IAudioMeterInformation.GetMeteringChannelCount");
                if (count == 0 || count > 256)
                    throw new InvalidOperationException("The audio driver returned an invalid metering channel count.");
                var values = new float[count];
                Check(Meter.GetChannelsPeakValues(count, values),
                    "IAudioMeterInformation.GetChannelsPeakValues");
                for (int i = 0; i < values.Length; i++)
                {
                    if (float.IsNaN(values[i]) || float.IsInfinity(values[i]) || values[i] < 0.0f || values[i] > 1.0f)
                        throw new InvalidOperationException("The audio driver returned an invalid peak value.");
                }
                return values;
            }

            public List<AudioSessionInfo> ReadSessions()
            {
                IAudioSessionEnumerator enumerator = null;
                try
                {
                    Check(SessionManager.GetSessionEnumerator(out enumerator),
                        "IAudioSessionManager2.GetSessionEnumerator");
                    int count;
                    Check(enumerator.GetCount(out count), "IAudioSessionEnumerator.GetCount");
                    if (count < 0 || count > 4096)
                        throw new InvalidOperationException("The audio driver returned an invalid session count.");
                    var result = new List<AudioSessionInfo>(count);
                    for (int i = 0; i < count; i++)
                    {
                        IAudioSessionControl control = null;
                        try
                        {
                            Check(enumerator.GetSession(i, out control), "IAudioSessionEnumerator.GetSession");
                            if (control == null)
                                throw new InvalidOperationException("IAudioSessionEnumerator returned a null session.");
                            // IAudioSessionControl2 and ISimpleAudioVolume are borrowed aliases of this RCW.
                            using (var session = new SessionHandle(control))
                            {
                                control = null;
                                result.Add(session.ReadInfo());
                            }
                        }
                        finally
                        {
                            ReleaseCom(ref control);
                        }
                    }
                    return result;
                }
                finally
                {
                    ReleaseCom(ref enumerator);
                }
            }

            public SessionHandle FindSession(string instanceId)
            {
                IAudioSessionEnumerator enumerator = null;
                SessionHandle found = null;
                try
                {
                    Check(SessionManager.GetSessionEnumerator(out enumerator),
                        "IAudioSessionManager2.GetSessionEnumerator");
                    int count;
                    Check(enumerator.GetCount(out count), "IAudioSessionEnumerator.GetCount");
                    if (count < 0 || count > 4096)
                        throw new InvalidOperationException("The audio driver returned an invalid session count.");
                    for (int i = 0; i < count; i++)
                    {
                        IAudioSessionControl control = null;
                        SessionHandle candidate = null;
                        try
                        {
                            Check(enumerator.GetSession(i, out control), "IAudioSessionEnumerator.GetSession");
                            candidate = new SessionHandle(control);
                            control = null;
                            if (string.Equals(candidate.InstanceId, instanceId, StringComparison.Ordinal))
                            {
                                if (found != null)
                                    throw new InvalidOperationException("The session instance ID is ambiguous.");
                                found = candidate;
                                candidate = null; // Transfer this owned RCW to the selected handle.
                            }
                        }
                        finally
                        {
                            if (candidate != null)
                                candidate.Dispose();
                            ReleaseCom(ref control);
                        }
                    }
                    if (found == null)
                        throw new InvalidOperationException("The requested session instance ID was not found on this endpoint.");
                    var result = found;
                    found = null; // Caller owns the selected handle.
                    return result;
                }
                finally
                {
                    if (found != null)
                        found.Dispose();
                    ReleaseCom(ref enumerator);
                }
            }

            public void Dispose()
            {
                try
                {
                    ReleaseCom(ref _sessions);
                    ReleaseCom(ref _meter);
                    ReleaseCom(ref _volume);
                }
                finally
                {
                    ReleaseCom(ref _device);
                }
            }
        }

        private sealed class SessionHandle : IDisposable
        {
            private IAudioSessionControl _control;
            private readonly IAudioSessionControl2 _control2;
            private readonly ISimpleAudioVolume _simpleVolume;

            public SessionHandle(IAudioSessionControl control)
            {
                _control = control ?? throw new ArgumentNullException(nameof(control));
                _control2 = (IAudioSessionControl2)_control;
                _simpleVolume = (ISimpleAudioVolume)_control;
            }

            public string InstanceId
            {
                get
                {
                    string value;
                    Check(_control2.GetSessionInstanceIdentifier(out value),
                        "IAudioSessionControl2.GetSessionInstanceIdentifier");
                    ValidateReturnedString(value, "session instance ID");
                    return value;
                }
            }

            public AudioSessionInfo ReadInfo()
            {
                string instanceId = InstanceId;
                string sessionId;
                Check(_control2.GetSessionIdentifier(out sessionId),
                    "IAudioSessionControl2.GetSessionIdentifier");
                ValidateReturnedString(sessionId, "session ID");

                uint processId;
                Check(_control2.GetProcessId(out processId), "IAudioSessionControl2.GetProcessId");

                AudioSessionState state;
                Check(_control.GetState(out state), "IAudioSessionControl.GetState");
                if (state != AudioSessionState.Inactive && state != AudioSessionState.Active
                    && state != AudioSessionState.Expired)
                    throw new InvalidOperationException("The audio driver returned an invalid session state.");

                string description = string.Empty;
                try
                {
                    Check(_control.GetDisplayName(out description), "IAudioSessionControl.GetDisplayName");
                    if (description == null)
                        description = string.Empty;
                }
                catch (COMException)
                {
                    // Display names are optional for some system sessions.
                    description = string.Empty;
                }

                float volume;
                Check(_simpleVolume.GetMasterVolume(out volume), "ISimpleAudioVolume.GetMasterVolume");
                bool muted;
                Check(_simpleVolume.GetMute(out muted), "ISimpleAudioVolume.GetMute");
                if (float.IsNaN(volume) || float.IsInfinity(volume) || volume < 0.0f || volume > 1.0f)
                    throw new InvalidOperationException("The audio driver returned an invalid session volume.");
                return new AudioSessionInfo(instanceId, sessionId, processId, description,
                    state == AudioSessionState.Active, volume * 100.0f, muted);
            }

            public void Write(float? volumePercent, bool? muted)
            {
                Guid context = ChangeContext;
                if (volumePercent.HasValue)
                    Check(_simpleVolume.SetMasterVolume(volumePercent.Value / 100.0f, ref context),
                        "ISimpleAudioVolume.SetMasterVolume");
                if (muted.HasValue)
                    Check(_simpleVolume.SetMute(muted.Value, ref context), "ISimpleAudioVolume.SetMute");
            }

            public void Dispose()
            {
                // _control2 and _simpleVolume are borrowed aliases; release the owned control once.
                ReleaseCom(ref _control);
            }

            private static void ValidateReturnedString(string value, string name)
            {
                if (string.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0)
                    throw new InvalidOperationException("The audio driver returned an invalid " + name + ".");
            }
        }

        private enum AudioSessionState
        {
            Inactive = 0,
            Active = 1,
            Expired = 2
        }

        [ComImport]
        [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumeratorComObject
        {
        }

        [ComImport]
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IMMDeviceCollection devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
            [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
            [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
        }

        [ComImport]
        [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceCollection
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int Item(uint index, out IMMDevice device);
        }

        [ComImport]
        [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, uint clsctx, IntPtr activationParams,
                [MarshalAs(UnmanagedType.IUnknown)] out object instance);
            [PreserveSig] int OpenPropertyStore(uint accessMode, out IntPtr properties);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out uint state);
        }

        [ComImport]
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioEndpointVolume
        {
            [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
            [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
            [PreserveSig] int GetChannelCount(out uint count);
            [PreserveSig] int SetMasterVolumeLevel(float decibels, ref Guid context);
            [PreserveSig] int SetMasterVolumeLevelScalar(float scalar, ref Guid context);
            [PreserveSig] int GetMasterVolumeLevel(out float decibels);
            [PreserveSig] int GetMasterVolumeLevelScalar(out float scalar);
            [PreserveSig] int SetChannelVolumeLevel(uint channel, float decibels, ref Guid context);
            [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float scalar, ref Guid context);
            [PreserveSig] int GetChannelVolumeLevel(uint channel, out float decibels);
            [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float scalar);
            [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
            [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
            [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
            [PreserveSig] int VolumeStepUp(ref Guid context);
            [PreserveSig] int VolumeStepDown(ref Guid context);
            [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
            [PreserveSig] int GetVolumeRange(out float minDecibels, out float maxDecibels, out float incrementDecibels);
        }

        [ComImport]
        [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioMeterInformation
        {
            [PreserveSig] int GetPeakValue(out float peak);
            [PreserveSig] int GetMeteringChannelCount(out uint channelCount);
            [PreserveSig]
            int GetChannelsPeakValues(uint channelCount,
                [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peakValues);
            [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
        }

        [ComImport]
        [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionManager2
        {
            [PreserveSig] int GetAudioSessionControl(ref Guid audioSessionGuid, uint streamFlags,
                out IAudioSessionControl sessionControl);
            [PreserveSig] int GetSimpleAudioVolume(ref Guid audioSessionGuid, uint streamFlags,
                out ISimpleAudioVolume audioVolume);
            [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
            [PreserveSig] int RegisterSessionNotification(IntPtr notification);
            [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
            [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId,
                IntPtr notification);
            [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
        }

        [ComImport]
        [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionEnumerator
        {
            [PreserveSig] int GetCount(out int count);
            [PreserveSig] int GetSession(int sessionIndex, out IAudioSessionControl sessionControl);
        }

        [ComImport]
        [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionControl
        {
            [PreserveSig] int GetState(out AudioSessionState state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
            [PreserveSig] int GetGroupingParam(out Guid groupingId);
            [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        }

        [ComImport]
        [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSessionControl2
        {
            [PreserveSig] int GetState(out AudioSessionState state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
            [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
            [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
            [PreserveSig] int GetGroupingParam(out Guid groupingId);
            [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
            [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionId);
            [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string instanceId);
            [PreserveSig] int GetProcessId(out uint processId);
            [PreserveSig] int IsSystemSoundsSession();
            [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
        }

        [ComImport]
        [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ISimpleAudioVolume
        {
            [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
            [PreserveSig] int GetMasterVolume(out float level);
            [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
            [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        }
    }
}
