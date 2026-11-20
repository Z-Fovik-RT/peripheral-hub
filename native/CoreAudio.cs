using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace PeripheralHub
{
    /// <summary>A snapshot of one active Windows audio endpoint.</summary>
    public sealed class AudioEndpoint
    {
        public string Id { get; private set; }
        public string Name { get; private set; }
        public string Flow { get; private set; }
        public float Volume { get; private set; }
        public bool Muted { get; private set; }

        internal AudioEndpoint(string id, string name, string flow, float volume, bool muted)
        {
            Id = id;
            Name = name;
            Flow = flow;
            Volume = volume;
            Muted = muted;
        }
    }

    /// <summary>Identity metadata for one active endpoint, without activating an audio interface.</summary>
    public sealed class AudioEndpointIdentity
    {
        public string Id { get; private set; }
        public string Name { get; private set; }
        public string Flow { get; private set; }
        public string InstanceId { get; private set; }
        public string IdentityError { get; private set; }

        internal AudioEndpointIdentity(string id, string name, string flow, string instanceId, string identityError)
        {
            Id = id;
            Name = name;
            Flow = flow;
            InstanceId = instanceId;
            IdentityError = identityError;
        }
    }

    /// <summary>
    /// Synchronous Core Audio access. Each call owns and releases its COM objects.
    /// Endpoint IDs, not names or default-device roles, identify all read/write targets.
    /// </summary>
    public static class CoreAudio
    {
        private const uint DeviceStateActive = 0x00000001;
        private const uint ClsctxAll = 0x00000017;
        private const uint StgmRead = 0;
        private static readonly Guid EndpointVolumeIid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        private static readonly Guid ChangeContext = new Guid("C0729F59-3C04-49DD-9C19-1FB5582F2069");
        private static readonly PropertyKey FriendlyNameKey = new PropertyKey(
            new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);

        // Windows SDK functiondiscoverykeys_devpkey.h: PKEY_Device_InstanceId, DEVPROP_TYPE_STRING.
        private static readonly PropertyKey InstanceIdKey = new PropertyKey(
            new Guid("78C34FC8-104A-4ACA-9EA4-524D52996E57"), 256);

        /// <summary>
        /// Reads active render/capture endpoint metadata without activating volume, audio client, or APO interfaces.
        /// Property failures remain on the affected endpoint; failures enumerating endpoints are thrown.
        /// </summary>
        public static List<AudioEndpointIdentity> ListEndpointIdentities()
        {
            EnsureWindows();
            var result = new List<AudioEndpointIdentity>();
            using (var enumerator = new EnumeratorHandle())
            {
                IMMDeviceCollection collection = null;
                try
                {
                    Check(enumerator.Instance.EnumAudioEndpoints(DataFlow.All, DeviceStateActive, out collection),
                        "IMMDeviceEnumerator.EnumAudioEndpoints");
                    uint count;
                    Check(collection.GetCount(out count), "IMMDeviceCollection.GetCount");
                    for (uint index = 0; index < count; index++)
                    {
                        IMMDevice device = null;
                        try
                        {
                            Check(collection.Item(index, out device), "IMMDeviceCollection.Item");
                            using (var endpoint = new EndpointHandle(device))
                            {
                                device = null; // Ownership transfers to EndpointHandle.
                                result.Add(endpoint.ReadIdentity());
                            }
                        }
                        finally
                        {
                            ReleaseCom(ref device);
                        }
                    }
                }
                finally
                {
                    ReleaseCom(ref collection);
                }
            }
            return result;
        }

        public static List<AudioEndpoint> ListEndpoints()
        {
            EnsureWindows();
            var result = new List<AudioEndpoint>();
            using (var enumerator = new EnumeratorHandle())
            {
                IMMDeviceCollection collection = null;
                try
                {
                    Check(enumerator.Instance.EnumAudioEndpoints(DataFlow.All, DeviceStateActive, out collection),
                        "IMMDeviceEnumerator.EnumAudioEndpoints");
                    uint count;
                    Check(collection.GetCount(out count), "IMMDeviceCollection.GetCount");
                    for (uint index = 0; index < count; index++)
                    {
                        IMMDevice device = null;
                        try
                        {
                            Check(collection.Item(index, out device), "IMMDeviceCollection.Item");
                            using (var endpoint = new EndpointHandle(device))
                            {
                                device = null; // Ownership transfers to EndpointHandle.
                                result.Add(endpoint.Read());
                            }
                        }
                        finally
                        {
                            ReleaseCom(ref device);
                        }
                    }
                }
                finally
                {
                    ReleaseCom(ref collection);
                }
            }
            return result;
        }

        public static AudioEndpoint Get(string id)
        {
            ValidateId(id);
            EnsureWindows();
            using (var enumerator = new EnumeratorHandle())
            using (var endpoint = enumerator.Open(id))
            {
                return endpoint.Read();
            }
        }

        /// <summary>
        /// Sets the supplied fields of a single active endpoint, then reads it back.
        /// Volume and mute are separate OS calls; failures restore and verify the immediate pre-change state.
        /// </summary>
        public static AudioEndpoint Set(string id, float? volume, bool? muted)
        {
            ValidateId(id);
            if (!volume.HasValue && !muted.HasValue)
                throw new ArgumentException("Supply volume, muted, or both.");
            if (volume.HasValue && (float.IsNaN(volume.Value) || float.IsInfinity(volume.Value)
                || volume.Value < 0.0f || volume.Value > 100.0f))
                throw new ArgumentOutOfRangeException(nameof(volume), volume,
                    "Volume must be a finite number between 0 and 100 inclusive.");

            EnsureWindows();
            using (var enumerator = new EnumeratorHandle())
            using (var endpoint = enumerator.Open(id))
            {
                var before = endpoint.Read();
                try
                {
                    endpoint.Write(volume, muted);
                    var actual = endpoint.Read();
                    if ((volume.HasValue && Math.Abs(actual.Volume - volume.Value) > 0.5f)
                        || (muted.HasValue && actual.Muted != muted.Value))
                        throw new InvalidOperationException("Audio readback differs from the requested state.");
                    return actual;
                }
                catch (Exception applyError)
                {
                    try
                    {
                        endpoint.Write(before.Volume, before.Muted);
                        var restored = endpoint.Read();
                        if (Math.Abs(restored.Volume - before.Volume) > 0.5f || restored.Muted != before.Muted)
                            throw new InvalidOperationException("Audio recovery readback differs from its baseline.");
                    }
                    catch (Exception recoveryError)
                    {
                        throw new AggregateException("Audio apply failed and recovery needs retry. The saved baseline must be retained.", applyError, recoveryError);
                    }
                    throw new InvalidOperationException("Audio apply failed; the immediately previous state was restored and verified.", applyError);
                }
            }
        }

        private static void ValidateId(string id)
        {
            if (string.IsNullOrWhiteSpace(id) || id.IndexOf('\0') >= 0)
                throw new ArgumentException("A complete endpoint ID without embedded NUL characters is required.", nameof(id));
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

        // Only release owned RCWs once. Interface casts on the same RCW are borrowed aliases.
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
            public IMMDeviceEnumerator Instance
            {
                get
                {
                    if (_instance == null)
                        throw new ObjectDisposedException(nameof(EnumeratorHandle));
                    return _instance;
                }
            }

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

            public EndpointHandle Open(string id)
            {
                IMMDevice device = null;
                try
                {
                    Check(Instance.GetDevice(id, out device), "IMMDeviceEnumerator.GetDevice");
                    var endpoint = new EndpointHandle(device);
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
            private IAudioEndpointVolume _volume;

            public EndpointHandle(IMMDevice device)
            {
                _device = device ?? throw new ArgumentNullException(nameof(device));
            }

            private void EnsureActive()
            {
                if (_device == null)
                    throw new ObjectDisposedException(nameof(EndpointHandle));
                uint state;
                Check(_device.GetState(out state), "IMMDevice.GetState");
                if ((state & DeviceStateActive) == 0)
                    throw new InvalidOperationException("The requested audio endpoint is not active.");
            }

            private IAudioEndpointVolume VolumeControl
            {
                get
                {
                    if (_volume == null)
                    {
                        object activated = null;
                        try
                        {
                            Guid iid = EndpointVolumeIid;
                            Check(_device.Activate(ref iid, ClsctxAll, IntPtr.Zero, out activated),
                                "IMMDevice.Activate(IAudioEndpointVolume)");
                            _volume = (IAudioEndpointVolume)activated;
                            activated = null;
                        }
                        finally
                        {
                            ReleaseCom(ref activated);
                        }
                    }
                    return _volume;
                }
            }

            public AudioEndpointIdentity ReadIdentity()
            {
                if (_device == null)
                    throw new ObjectDisposedException(nameof(EndpointHandle));
                string id;
                Check(_device.GetId(out id), "IMMDevice.GetId");
                DataFlow flow;
                // IMMEndpoint is a borrowed alias of the device RCW; do not release it separately.
                Check(((IMMEndpoint)_device).GetDataFlow(out flow), "IMMEndpoint.GetDataFlow");
                if (flow != DataFlow.Render && flow != DataFlow.Capture)
                    throw new InvalidOperationException("The audio endpoint has an unsupported data flow.");

                var errors = new List<string>();
                string name = null;
                string instanceId = null;
                IPropertyStore store = null;
                try
                {
                    bool opened = false;
                    try
                    {
                        Check(_device.OpenPropertyStore(StgmRead, out store), "IMMDevice.OpenPropertyStore");
                        if (store == null)
                            throw new InvalidOperationException("IMMDevice.OpenPropertyStore returned no property store.");
                        opened = true;
                    }
                    catch (Exception error)
                    {
                        errors.Add("PKEY_Device_FriendlyName / PKEY_Device_InstanceId: " + error.Message);
                    }
                    if (opened)
                    {
                        name = ReadIdentityProperty(store, FriendlyNameKey, "PKEY_Device_FriendlyName", errors);
                        instanceId = ReadIdentityProperty(store, InstanceIdKey, "PKEY_Device_InstanceId", errors);
                    }
                }
                finally
                {
                    ReleaseCom(ref store);
                }
                return new AudioEndpointIdentity(id, name ?? id, flow == DataFlow.Render ? "render" : "capture",
                    instanceId, errors.Count == 0 ? null : string.Join("; ", errors));
            }

            private static string ReadIdentityProperty(IPropertyStore store, PropertyKey key,
                string propertyName, List<string> errors)
            {
                PropVariant value = default(PropVariant);
                string result = null;
                try
                {
                    Check(store.GetValue(ref key, out value), "IPropertyStore.GetValue(" + propertyName + ")");
                    string text = value.GetString();
                    if (string.IsNullOrWhiteSpace(text) || text.IndexOf('\0') >= 0)
                        throw new InvalidOperationException("The property is missing, empty, or contains an embedded NUL.");
                    result = text;
                }
                catch (Exception error)
                {
                    errors.Add(propertyName + ": " + error.Message);
                }
                finally
                {
                    try
                    {
                        value.Dispose();
                    }
                    catch (Exception error)
                    {
                        result = null;
                        errors.Add(propertyName + " cleanup: " + error.Message);
                    }
                }
                return result;
            }

            public AudioEndpoint Read()
            {
                EnsureActive();
                string id;
                Check(_device.GetId(out id), "IMMDevice.GetId");
                DataFlow flow;
                // IMMEndpoint is a borrowed interface on the device RCW, not a second owned RCW.
                Check(((IMMEndpoint)_device).GetDataFlow(out flow), "IMMEndpoint.GetDataFlow");
                if (flow != DataFlow.Render && flow != DataFlow.Capture)
                    throw new InvalidOperationException("The audio endpoint has an unsupported data flow.");

                string name = ReadFriendlyName(id);
                float scalar;
                bool muted;
                IAudioEndpointVolume volume = VolumeControl;
                Check(volume.GetMasterVolumeLevelScalar(out scalar), "IAudioEndpointVolume.GetMasterVolumeLevelScalar");
                Check(volume.GetMute(out muted), "IAudioEndpointVolume.GetMute");
                if (float.IsNaN(scalar) || float.IsInfinity(scalar) || scalar < 0.0f || scalar > 1.0f)
                    throw new InvalidOperationException("The audio driver returned an invalid volume scalar.");
                return new AudioEndpoint(id, name, flow == DataFlow.Render ? "render" : "capture",
                    scalar * 100.0f, muted);
            }

            private string ReadFriendlyName(string fallback)
            {
                IPropertyStore store = null;
                PropVariant value = default(PropVariant);
                try
                {
                    Check(_device.OpenPropertyStore(StgmRead, out store), "IMMDevice.OpenPropertyStore");
                    PropertyKey key = FriendlyNameKey;
                    Check(store.GetValue(ref key, out value), "IPropertyStore.GetValue(PKEY_Device_FriendlyName)");
                    string name = value.GetString();
                    return string.IsNullOrEmpty(name) ? fallback : name;
                }
                finally
                {
                    try
                    {
                        value.Dispose();
                    }
                    finally
                    {
                        ReleaseCom(ref store);
                    }
                }
            }

            public void Write(float? volume, bool? muted)
            {
                EnsureActive();
                IAudioEndpointVolume control = VolumeControl;
                Guid context = ChangeContext;
                if (volume.HasValue)
                    Check(control.SetMasterVolumeLevelScalar(volume.Value / 100.0f, ref context),
                        "IAudioEndpointVolume.SetMasterVolumeLevelScalar");
                if (muted.HasValue)
                    Check(control.SetMute(muted.Value, ref context), "IAudioEndpointVolume.SetMute");
            }

            public void Dispose()
            {
                try
                {
                    ReleaseCom(ref _volume);
                }
                finally
                {
                    ReleaseCom(ref _device);
                }
            }
        }

        private enum DataFlow
        {
            Render = 0,
            Capture = 1,
            All = 2
        }

        private enum Role
        {
            Console = 0,
            Multimedia = 1,
            Communications = 2
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PropertyKey
        {
            public Guid FormatId;
            public uint PropertyId;

            public PropertyKey(Guid formatId, uint propertyId)
            {
                FormatId = formatId;
                PropertyId = propertyId;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CountedPointer
        {
            public uint Count;
            public IntPtr Pointer;
        }

        // The union's counted-pointer member gives PROPVARIANT its native size:
        // 24 bytes on x64/ARM64, 16 on x86, with the value starting at offset 8.
        [StructLayout(LayoutKind.Explicit)]
        private struct PropVariant : IDisposable
        {
            [FieldOffset(0)] private ushort _variantType;
            [FieldOffset(8)] private IntPtr _pointer;
            [FieldOffset(8)] private CountedPointer _countedPointer;

            public string GetString()
            {
                switch (_variantType)
                {
                    case 0: // VT_EMPTY
                    case 1: // VT_NULL
                        return null;
                    case 8: // VT_BSTR
                        return _pointer == IntPtr.Zero ? null : Marshal.PtrToStringBSTR(_pointer);
                    case 30: // VT_LPSTR
                        return Marshal.PtrToStringAnsi(_pointer);
                    case 31: // VT_LPWSTR (PKEY_Device_FriendlyName)
                        return Marshal.PtrToStringUni(_pointer);
                    default:
                        throw new InvalidOperationException("Expected a string PROPVARIANT; received VT=" + _variantType + ".");
                }
            }

            public void Dispose()
            {
                Check(PropVariantClear(ref this), "PropVariantClear");
                this = default(PropVariant);
            }
        }

        [DllImport("ole32.dll", ExactSpelling = true, PreserveSig = true)]
        private static extern int PropVariantClear(ref PropVariant value);

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
            [PreserveSig] int EnumAudioEndpoints(DataFlow dataFlow, uint stateMask, out IMMDeviceCollection devices);
            [PreserveSig] int GetDefaultAudioEndpoint(DataFlow dataFlow, Role role, out IMMDevice endpoint);
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
            [PreserveSig] int OpenPropertyStore(uint accessMode, out IPropertyStore properties);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out uint state);
        }

        [ComImport]
        [Guid("1BE09788-6894-4089-8586-9A2A6C265AC5")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMEndpoint
        {
            [PreserveSig] int GetDataFlow(out DataFlow dataFlow);
        }

        [ComImport]
        [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
            [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
            [PreserveSig] int Commit();
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
    }
}
