using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace PeripheralHub
{
    public sealed class IkfDirectProperty
    {
        public string Feature { get; set; }
        public string Field { get; set; }
        public int Index { get; set; }
        public string SdkProperty { get; set; }
        public string InfSymbol { get; set; }
        public string Context { get; set; }
        public string PropertyGuid { get; set; }
        public uint PropertyId { get; set; }
        public bool Boolean { get; set; }
        public int Minimum { get; set; }
        public int Maximum { get; set; }
        public int[] Allowed { get; set; }
    }

    public sealed class IkfDirectValue
    {
        public IkfDirectProperty Property { get; set; }
        public string Status { get; set; }
        public string HResult { get; set; }
        public ushort? VariantType { get; set; }
        public uint? RawDword { get; set; }
        public int? Value { get; set; }
        public string Error { get; set; }
    }

    public sealed class IkfDirectContext
    {
        public string Context { get; set; }
        public string Status { get; set; }
        public string HResult { get; set; }
        public string Error { get; set; }
    }

    public sealed class IkfDirectSnapshot
    {
        public string EndpointId { get; set; }
        public string Flow { get; set; }
        public string EndpointInstanceId { get; set; }
        public string IdentitySource { get; set; }
        public string IdentityWarning { get; set; }
        public string UsbInterfaceId { get; set; }
        public string UsbParentId { get; set; }
        public bool IdentityVerified { get; set; }
        public bool AllPropertiesRead { get; set; }
        public bool WriteSupported { get { return false; } }
        public bool LicenseVerified { get { return false; } }
        public bool EffectBehaviorVerified { get { return false; } }
        public string Error { get; set; }
        public List<IkfDirectContext> Contexts { get; set; } = new List<IkfDirectContext>();
        public List<IkfDirectValue> Values { get; set; } = new List<IkfDirectValue>();
        public Dictionary<string, Dictionary<string, object>> States { get; set; } = new Dictionary<string, Dictionary<string, object>>();
    }

    public sealed class IkfDirectWriteResult
    {
        public string EndpointId { get; set; }
        public string Feature { get; set; }
        public string Status { get; set; }
        public IkfDirectSnapshot Identity { get; set; }
        public List<IkfDirectValue> Before { get; set; } = new List<IkfDirectValue>();
        public List<IkfDirectValue> Actual { get; set; } = new List<IkfDirectValue>();
        public List<IkfDirectValue> Restored { get; set; } = new List<IkfDirectValue>();
        public Dictionary<string, object> RequestedState { get; set; }
        public Dictionary<string, object> BeforeState { get; set; }
        public Dictionary<string, object> ActualState { get; set; }
        public Dictionary<string, object> RestoredState { get; set; }
        public int WriteAttempts { get; set; }
        public int CommitAttempts { get; set; }
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

    internal interface IIkfDirectFamilyStore : IDisposable
    {
        IkfDirectSnapshot Identity { get; }
        void AssertIdentity();
        List<IkfDirectValue> ReadFamily(IkfDirectProperty[] fields);
        void PrepareWrite();
        void Write(IkfDirectProperty property, ushort variantType, uint rawDword);
        void Commit();
    }

    // Windows CAPX access to the fixed INF keys. No vendor DLL loading or registry writes.
    public static class IkfDirectAudio
    {
        private const string Sfx = "C31A35A5-22EC-425E-9B74-B64700F067DA";
        private const string Mfx = "4C6C316B-C24F-421C-A266-690540CABD11";
        private const string Efx = "9C97FB8F-7C45-4EF3-A5A8-67D0AC630E8F";
        private const string Combined = "5E96E4D9-FF2C-4D84-9BD6-FE10CF815009";
        private const string Eq = "BD341FFB-9FD1-4ED4-8159-7999D546EA8A";
        private const string Surround = "C020CDBF-756F-4B6D-9031-BE6E20CF1C9F";
        private const string Copy = "31AF2432-4E37-47C5-9785-9D9529E07129";
        private const string Magic = "3BC6329A-2397-4FF3-92F5-2CD9894BB889";
        private const string Noise = "B1132012-70C8-49CF-B860-E34ADA163170";
        private static readonly Guid EffectsStoreIid = new Guid("302AE7F9-D7E0-43E4-971B-1F8293613D2A");
        private static readonly PropertyKey InstanceIdKey = new PropertyKey(new Guid("78C34FC8-104A-4ACA-9EA4-524D52996E57"), 256);

        private static string ValidateEndpointId(string endpointId)
        {
            if (endpointId == null || !Regex.IsMatch(endpointId, @"^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$")) throw new ArgumentException("A complete Windows render/capture endpoint ID is required.", nameof(endpointId));
            return endpointId.StartsWith("{0.0.0.", StringComparison.Ordinal) ? "render" : "capture";
        }

        public static IkfDirectProperty[] Describe(string flow)
        {
            if (flow != "render" && flow != "capture") throw new ArgumentException("Flow must be render or capture.", nameof(flow));
            var fields = new List<IkfDirectProperty>();
            if (flow == "render")
            {
                Add(fields, "eq", "enabled", "Enable_EQ_GFX", "PKEY_Endpoint_Enable_EQ_GFX", Mfx, Eq, 0, 0, 1, true);
                for (int band = 1; band <= 10; band++) Add(fields, "eq", "bandsRaw", "EQ_Slider" + band, "PKEY_Endpoint_EQ_Slider" + band, Mfx, Eq, (uint)band, -20, 20, false, null, band - 1);
                Add(fields, "surround71", "enabled", "Enable_CONLAB_HPSPK_LFX", "PKEY_Endpoint_Enable_CONLAB_HPSPK_LFX", Efx, Surround, 0, 0, 1, true);
                Add(fields, "surround71", "modeRaw", "CONLAB_HPSPK_MODE", "PKEY_Endpoint_CONLAB_HPSPK_MODE", Efx, Surround, 5, 0, 1, false, new[] { 0, 1 });
                Add(fields, "surround71", "roomSizeRaw", "CONLAB_HPSPK_ROOMSIZE", "PKEY_Endpoint_CONLAB_HPSPK_ROOMSIZE", Efx, Surround, 2, 0, 2, false, new[] { 0, 1, 2 });
                Add(fields, "brilliant", "enabled", "Enable_AUDIOBRILLIANT_LFX", "PKEY_Endpoint_Enable_AUDIOBRILLIANT_LFX", Sfx, Combined, 0, 0, 1, true);
                Add(fields, "brilliant", "levelRaw", "AUDIOBRILLIANT_LEVEL", "PKEY_Endpoint_AUDIOBRILLIANT_LEVEL", Sfx, Combined, 1, 0, 10);
                Add(fields, "dynamicBass", "enabled", "Enable_VIRTUALBASS_LFX", "PKEY_Endpoint_Enable_VIRTUALBASS_LFX", Sfx, Combined, 5, 0, 1, true);
                Add(fields, "dynamicBass", "modeRaw", "VIRTUALBASS_Mode", "PKEY_Endpoint_VIRTUALBASS_Mode", Sfx, Combined, 6, Int32.MinValue, Int32.MaxValue);
                Add(fields, "dynamicBass", "levelRaw", "VIRTUALBASS_Level", "PKEY_Endpoint_VIRTUALBASS_Level", Sfx, Combined, 7, 0, 10);
                Add(fields, "dynamicBass", "cutoffRaw", "VIRTUALBASS_CutOffFrequency", "PKEY_Endpoint_VIRTUALBASS_CutOffFrequency", Sfx, Combined, 8, 100, 400, false, new[] { 100, 150, 200, 300, 400 });
                Add(fields, "smartVolume", "enabled", "Enable_ADAPTIVEVOLUME_GFX", "PKEY_Endpoint_Enable_ADAPTIVEVOLUME_GFX", Mfx, Combined, 9, 0, 1, true);
                Add(fields, "smartVolume", "levelRaw", "ADAPTIVEVOLUME_LEVEL", "PKEY_Endpoint_ADAPTIVEVOLUME_LEVEL", Mfx, Combined, 10, 0, 100);
                Add(fields, "smartVolume", "modeRaw", "ADAPTIVEVOLUME_MODE", "PKEY_Endpoint_ADAPTIVEVOLUME_MODE", Mfx, Combined, 11, 0, 1, false, new[] { 0, 1 });
                Add(fields, "voiceClarity", "enabled", "Enable_VOICECLARITY_LFX", "PKEY_Endpoint_Enable_VOICECLARITY_LFX", Sfx, Combined, 2, 0, 1, true);
                Add(fields, "voiceClarity", "levelRaw", "VOICECLARITY_LEVEL", "PKEY_Endpoint_VOICECLARITY_LEVEL", Sfx, Combined, 3, 0, 10);
                Add(fields, "voiceClarity", "noiseSuppressionRaw", "VOICECLARITY_NOISESUPP_LEVEL", "PKEY_Endpoint_VOICECLARITY_NOISESUPP_LEVEL", Sfx, Combined, 4, 0, 20, false, new[] { 0, 5, 10, 15, 20 });
                Add(fields, "surroundMax", "enabled", "Enable_Channel_COPY_LFX", "PKEY_Endpoint_Enable_Channel_COPY_LFX", Efx, Copy, 0, 0, 1, true);
            }
            else
            {
                Add(fields, "mic.magicVoice", "enabled", "Enable_MAGICVOICE", "PKEY_Endpoint_Enable_MAGICVOICE", Mfx, Magic, 2, 0, 1, true);
                Add(fields, "mic.magicVoice", "selectionRaw", "MagicVoice_Selection", "PKEY_Endpoint_MagicVoice_Selection", Mfx, Magic, 3, 0, 3, false, new[] { 0, 1, 2, 3 });
                Add(fields, "mic.nr", "enabled", "NR_Enable", "PKEY_CAPTURE_NR_ENABLE", Mfx, Noise, 0, 0, 1, true);
                Add(fields, "mic.nr", "levelRaw", "NR_Level", "PKEY_CAPTURE_NR_LEVEL", Mfx, Noise, 1, 6, 40);
            }
            return fields.ToArray();
        }

        private static void Add(List<IkfDirectProperty> fields, string feature, string field, string sdkProperty, string infSymbol, string context, string propertyGuid, uint propertyId, int minimum, int maximum, bool boolean = false, int[] allowed = null, int index = -1)
        {
            fields.Add(new IkfDirectProperty { Feature = feature, Field = field, Index = index, SdkProperty = sdkProperty, InfSymbol = infSymbol, Context = context, PropertyGuid = propertyGuid, PropertyId = propertyId, Minimum = minimum, Maximum = maximum, Boolean = boolean, Allowed = allowed });
        }

        internal static IkfDirectValue Decode(IkfDirectProperty property, int hr, ushort variantType, uint raw)
        {
            var result = new IkfDirectValue { Property = property, HResult = "0x" + hr.ToString("X8") };
            if (hr < 0) { result.Status = "read-error"; result.Error = Marshal.GetExceptionForHR(hr).Message; return result; }
            result.VariantType = variantType;
            if (variantType == 0 || variantType == 1) { result.Status = "missing"; return result; }
            if (variantType != 3 && variantType != 19) { result.Status = "unexpected-type"; result.Error = "Expected VT_I4 or VT_UI4 from the INF DWORD property."; return result; }
            result.RawDword = raw;
            int value = unchecked((int)raw);
            if (value < property.Minimum || value > property.Maximum || (property.Allowed != null && Array.IndexOf(property.Allowed, value) < 0))
            {
                result.Status = "outside-known-range"; result.Error = "The stored integer is outside the existing nine-family contract."; return result;
            }
            result.Status = "read"; result.Value = value; return result;
        }

        internal static Dictionary<string, Dictionary<string, object>> Project(IkfDirectProperty[] fields, List<IkfDirectValue> values)
        {
            var result = new Dictionary<string, Dictionary<string, object>>();
            foreach (var property in fields)
            {
                if (result.ContainsKey(property.Feature)) continue;
                var state = new Dictionary<string, object>(); bool complete = true;
                foreach (var expected in fields)
                {
                    if (expected.Feature != property.Feature) continue;
                    var matches = values.FindAll(value => value.Property.SdkProperty == expected.SdkProperty && value.Property.Context == expected.Context);
                    if (matches.Count != 1 || matches[0].Status != "read" || !matches[0].Value.HasValue) { complete = false; break; }
                    int value = matches[0].Value.Value;
                    if (expected.Index >= 0)
                    {
                        if (!state.ContainsKey(expected.Field)) state[expected.Field] = new int[10];
                        ((int[])state[expected.Field])[expected.Index] = value;
                    }
                    else state[expected.Field] = expected.Boolean ? (object)(value == 1) : value;
                }
                if (complete) result[property.Feature] = state;
            }
            return result;
        }

        internal static IkfDirectProperty[] FamilyFields(string flow, string feature)
        {
            var fields = Array.FindAll(Describe(flow), property => property.Feature == feature);
            if (fields.Length == 0) throw new ArgumentException("The feature is not one of the fixed families for this endpoint flow.", nameof(feature));
            return fields;
        }

        internal static Dictionary<string, object> ValidateState(IkfDirectProperty[] fields, IDictionary state)
        {
            if (state == null) throw new ArgumentNullException(nameof(state));
            var expected = new HashSet<string>(); foreach (var field in fields) expected.Add(field.Field);
            if (state.Count != expected.Count) throw new ArgumentException("A complete family state with no extra fields is required.", nameof(state));
            var input = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (DictionaryEntry entry in state)
            {
                var key = entry.Key as string;
                if (key == null || !expected.Contains(key) || input.ContainsKey(key)) throw new ArgumentException("Unknown, ambiguous or incorrectly cased family field.", nameof(state));
                input[key] = entry.Value;
            }
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var field in fields)
            {
                object value;
                if (!input.TryGetValue(field.Field, out value)) throw new ArgumentException("A required family field is missing.", nameof(state));
                if (field.Boolean)
                {
                    if (!(value is bool)) throw new ArgumentException("The enabled field must be a boolean.", nameof(state));
                    result[field.Field] = (bool)value;
                }
                else if (field.Index >= 0)
                {
                    if (result.ContainsKey(field.Field)) continue;
                    var array = value as IList;
                    if (array == null || array.Count != 10) throw new ArgumentException("Exactly ten integer EQ bands are required.", nameof(state));
                    var copy = new int[10];
                    for (int index = 0; index < 10; index++) copy[index] = ValidateInteger(field, array[index]);
                    result[field.Field] = copy;
                }
                else result[field.Field] = ValidateInteger(field, value);
            }
            return result;
        }

        private static int ValidateInteger(IkfDirectProperty field, object value)
        {
            if (!(value is int) && !(value is long)) throw new ArgumentException("Family scalar values must be Int32 or Int64 integers.");
            long number = value is int ? (int)value : (long)value;
            if (number < field.Minimum || number > field.Maximum || (field.Allowed != null && (number < Int32.MinValue || number > Int32.MaxValue || Array.IndexOf(field.Allowed, (int)number) < 0))) throw new ArgumentOutOfRangeException(nameof(value), "Value is outside the fixed family contract.");
            return (int)number;
        }

        private static uint DesiredDword(IkfDirectProperty field, Dictionary<string, object> state)
        {
            int value = field.Boolean ? ((bool)state[field.Field] ? 1 : 0) : field.Index >= 0 ? ((int[])state[field.Field])[field.Index] : (int)state[field.Field];
            return unchecked((uint)value);
        }

        private static IkfDirectValue RequireValue(List<IkfDirectValue> values, IkfDirectProperty field)
        {
            var matches = values.FindAll(value => value.Property.Context == field.Context && value.Property.PropertyGuid == field.PropertyGuid && value.Property.PropertyId == field.PropertyId);
            if (matches.Count != 1 || matches[0].Status != "read" || !matches[0].RawDword.HasValue || !matches[0].VariantType.HasValue) throw new InvalidOperationException("A complete, unambiguous DWORD baseline is required for " + field.SdkProperty + ".");
            return matches[0];
        }

        private static bool ExactMatch(IkfDirectProperty[] fields, List<IkfDirectValue> expected, List<IkfDirectValue> actual, Dictionary<string, object> desired = null)
        {
            if (expected.Count != fields.Length || actual.Count != fields.Length) return false;
            foreach (var field in fields)
            {
                var before = RequireValue(expected, field); var after = RequireValue(actual, field);
                if (before.VariantType != after.VariantType || after.RawDword != (desired == null ? before.RawDword : DesiredDword(field, desired))) return false;
            }
            return true;
        }

        public static IkfDirectWriteResult SetEndpointState(string endpointId, string feature, IDictionary state, Action<IkfDirectWriteResult> checkpoint)
        {
            string flow = ValidateEndpointId(endpointId);
            var fields = FamilyFields(flow, feature);
            var requested = ValidateState(fields, state);
            if (checkpoint == null) throw new ArgumentNullException(nameof(checkpoint), "An exact-before recovery checkpoint writer is required before any property mutation.");
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || !Environment.Is64BitProcess) throw new PlatformNotSupportedException("Direct audio writes require Windows x64.");
            using (var gate = new Mutex(false, "Local\\PeripheralHub.HeadsetAudio"))
            {
                bool owned = false;
                try
                {
                    try { owned = gate.WaitOne(20000); } catch (AbandonedMutexException) { owned = true; }
                    if (!owned) throw new InvalidOperationException("Another headset audio operation is active.");
                    using (var store = new WindowsFamilyStore(endpointId, fields[0].Context))
                    {
                        var result = ChangeFamily(endpointId, feature, fields, requested, store, checkpoint);
                        result.Identity = store.Identity;
                        return result;
                    }
                }
                finally { if (owned) gate.ReleaseMutex(); }
            }
        }

        internal static IkfDirectWriteResult ChangeFamily(string endpointId, string feature, IkfDirectProperty[] fields, Dictionary<string, object> requested, IIkfDirectFamilyStore store, Action<IkfDirectWriteResult> checkpoint)
        {
            var result = new IkfDirectWriteResult { EndpointId = endpointId, Feature = feature, Status = "blocked", RequestedState = requested, Identity = store.Identity };
            bool preparedCheckpointSaved = false;
            try
            {
                store.AssertIdentity();
                result.Before = store.ReadFamily(fields);
                if (result.Before.Count != fields.Length) throw new InvalidOperationException("Incomplete family baseline.");
                foreach (var field in fields) RequireValue(result.Before, field);
                result.BeforeState = Project(fields, result.Before)[feature];
                if (feature == "dynamicBass" && (int)result.BeforeState["modeRaw"] != (int)requested["modeRaw"]) throw new InvalidOperationException("Dynamic bass mode must preserve its currently read value.");
                if (ExactMatch(fields, result.Before, result.Before, requested))
                {
                    result.Status = "unchanged"; result.Actual = result.Before; result.ActualState = result.BeforeState; result.ReadbackVerified = true; return result;
                }
                store.PrepareWrite();
                result.Status = "prepared"; result.RecoveryRequired = true;
                checkpoint(result);
                preparedCheckpointSaved = true;
                store.AssertIdentity();
                WriteFamily(store, fields, result.Before, requested, result);
                result.CommitAttempts++; store.Commit();
                store.AssertIdentity();
                result.Actual = store.ReadFamily(fields);
                if (!ExactMatch(fields, result.Before, result.Actual, requested)) throw new InvalidOperationException("Direct property readback differs from the requested exact DWORD state.");
                result.ActualState = Project(fields, result.Actual)[feature];
                result.ReadbackVerified = true; result.RecoveryRequired = false; result.Status = "applied";
                checkpoint(result);
            }
            catch (Exception error)
            {
                result.Error = error.Message;
                if (result.MutationPossible)
                {
                    result.RecoveryRequired = true; result.Status = "restoring";
                    try { checkpoint(result); } catch (Exception journalError) { result.CheckpointError = journalError.Message; }
                    try
                    {
                        store.AssertIdentity(); store.PrepareWrite();
                        WriteFamily(store, fields, result.Before, null, result);
                        result.CommitAttempts++; store.Commit();
                        store.AssertIdentity(); result.Restored = store.ReadFamily(fields);
                        if (!ExactMatch(fields, result.Before, result.Restored)) throw new InvalidOperationException("Exact DWORD/type recovery readback differs from the immediately previous state.");
                        result.RestoredState = Project(fields, result.Restored)[feature];
                        result.RestorationVerified = true; result.RecoveryRequired = false; result.Status = "restored-after-failure";
                    }
                    catch (Exception recoveryError) { result.RecoveryError = recoveryError.Message; result.Status = "recovery-required"; }
                    try { checkpoint(result); }
                    catch (Exception journalError) { result.CheckpointError = journalError.Message; result.RecoveryRequired = true; result.Status = "recovery-record-pending"; }
                }
                else
                {
                    result.RecoveryRequired = false; result.Status = "blocked";
                    if (preparedCheckpointSaved)
                    {
                        try { checkpoint(result); }
                        catch (Exception journalError) { result.CheckpointError = journalError.Message; result.RecoveryRequired = true; result.Status = "recovery-record-pending"; }
                    }
                }
            }
            return result;
        }

        private static void WriteFamily(IIkfDirectFamilyStore store, IkfDirectProperty[] fields, List<IkfDirectValue> baseline, Dictionary<string, object> requested, IkfDirectWriteResult result)
        {
            // Parameters are staged first; the fixed enabled property is staged last.
            foreach (bool enabled in new[] { false, true }) foreach (var field in fields)
            {
                if (field.Boolean != enabled) continue;
                var before = RequireValue(baseline, field);
                result.MutationPossible = true; result.WriteAttempts++;
                store.Write(field, before.VariantType.Value, requested == null ? before.RawDword.Value : DesiredDword(field, requested));
            }
        }

        public static IkfDirectSnapshot ReadEndpoint(string endpointId)
        {
            return ReadFields(endpointId, null);
        }

        public static IkfDirectSnapshot ReadCaptureAec(string endpointId)
        {
            if (ValidateEndpointId(endpointId) != "capture") throw new ArgumentException("AEC diagnostics require a capture endpoint.", nameof(endpointId));
            var fields = new List<IkfDirectProperty>();
            Add(fields, "mic.aec", "enabled", "AEC_Enable", "PKEY_CAPTURE_AEC_ENABLE", Mfx, Noise, 2, 0, 1, true);
            Add(fields, "mic.aec", "levelRaw", "AEC_Level", "PKEY_CAPTURE_AEC_LEVEL", Mfx, Noise, 3, Int32.MinValue, Int32.MaxValue);
            Add(fields, "mic.aec", "delayRaw", "AEC_DelayTime", "PKEY_CAPTURE_AEC_DELAYTIME", Mfx, Noise, 4, Int32.MinValue, Int32.MaxValue);
            return ReadFields(endpointId, fields.ToArray());
        }

        private static IkfDirectSnapshot ReadFields(string endpointId, IkfDirectProperty[] selectedFields)
        {
            ValidateEndpointId(endpointId);
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || !Environment.Is64BitProcess) throw new PlatformNotSupportedException("This diagnostic requires Windows x64.");
            var result = new IkfDirectSnapshot { EndpointId = endpointId };
            IMMDeviceEnumerator enumerator = null; IMMDevice endpoint = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                Check(enumerator.GetDevice(endpointId, out endpoint), "IMMDeviceEnumerator.GetDevice");
                uint state; Check(endpoint.GetState(out state), "IMMDevice.GetState");
                if ((state & 1) == 0) throw new InvalidOperationException("Only an active endpoint may be read.");
                int flow; Check(((IMMEndpoint)endpoint).GetDataFlow(out flow), "IMMEndpoint.GetDataFlow");
                result.Flow = flow == 0 ? "render" : flow == 1 ? "capture" : throw new InvalidOperationException("Unsupported endpoint direction.");
                if ((flow == 0 && !endpointId.StartsWith("{0.0.0.", StringComparison.Ordinal)) || (flow == 1 && !endpointId.StartsWith("{0.0.1.", StringComparison.Ordinal))) throw new InvalidOperationException("Endpoint ID and direction disagree.");
                try
                {
                    result.EndpointInstanceId = ReadInstanceId(endpoint);
                    result.IdentitySource = "PKEY_Device_InstanceId plus present PnP parent chain";
                }
                catch (Exception identityError)
                {
                    result.EndpointInstanceId = "SWD\\MMDEVAPI\\" + endpointId;
                    result.IdentitySource = "Exact MMDEVAPI PnP endpoint node plus present PnP parent chain";
                    result.IdentityWarning = identityError.Message;
                }
                VerifyIdentity(result);
                result.IdentityVerified = true;
                var fields = selectedFields ?? Describe(result.Flow);
                var contexts = new HashSet<string>();
                foreach (var field in fields) contexts.Add(field.Context);
                foreach (var context in contexts) ReadContext(endpoint, context, fields, result);
                result.States = Project(fields, result.Values);
                result.AllPropertiesRead = result.Values.Count == fields.Length && result.Values.TrueForAll(value => value.Status == "read");
            }
            catch (Exception error) { result.Error = error.Message; }
            finally { Release(endpoint); Release(enumerator); }
            return result;
        }

        private static string ReadInstanceId(IMMDevice endpoint)
        {
            IPropertyStoreRead store = null; PropVariant value = default(PropVariant);
            try
            {
                Check(endpoint.OpenPropertyStore(0, out store), "IMMDevice.OpenPropertyStore(STGM_READ)");
                var key = InstanceIdKey;
                Check(store.GetValue(ref key, out value), "PKEY_Device_InstanceId");
                if (value.Type != 31 || value.Pointer == IntPtr.Zero) throw new InvalidOperationException("Endpoint instance ID is missing or has an unexpected type.");
                return Marshal.PtrToStringUni(value.Pointer);
            }
            finally { PropVariantClear(ref value); Release(store); }
        }

        private static void VerifyIdentity(IkfDirectSnapshot result)
        {
            if (!String.Equals(result.EndpointInstanceId, "SWD\\MMDEVAPI\\" + result.EndpointId, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Endpoint metadata does not identify its exact PnP endpoint.");
            uint node; CheckCr(CM_Locate_DevNodeW(out node, result.EndpointInstanceId, 0), "CM_Locate_DevNode");
            for (int depth = 0; depth < 12; depth++)
            {
                var id = new StringBuilder(512); CheckCr(CM_Get_Device_IDW(node, id, id.Capacity, 0), "CM_Get_Device_ID");
                string instance = id.ToString();
                if (Regex.IsMatch(instance, @"^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}&MI_[0-9A-F]{2}\\", RegexOptions.IgnoreCase))
                {
                    if (!Regex.IsMatch(instance, @"^USB\\VID_0E6A&PID_0110&MI_00\\[^\\]+$", RegexOptions.IgnoreCase)) throw new InvalidOperationException("Endpoint belongs to a different USB interface.");
                    result.UsbInterfaceId = instance;
                    uint parent; CheckCr(CM_Get_Parent(out parent, node, 0), "CM_Get_Parent(USB interface)");
                    var parentId = new StringBuilder(512); CheckCr(CM_Get_Device_IDW(parent, parentId, parentId.Capacity, 0), "CM_Get_Device_ID(USB parent)");
                    result.UsbParentId = parentId.ToString();
                    if (!Regex.IsMatch(result.UsbParentId, @"\AUSB\\VID_0E6A&PID_0110\\[^\\\x00-\x1f]+\z", RegexOptions.IgnoreCase)) throw new InvalidOperationException("Endpoint does not belong to the target USB headset model.");
                    return;
                }
                uint next; CheckCr(CM_Get_Parent(out next, node, 0), "CM_Get_Parent"); node = next;
            }
            throw new InvalidOperationException("The exact USB headset was not found within the endpoint parent chain.");
        }

        private static void ReadContext(IMMDevice endpoint, string context, IkfDirectProperty[] fields, IkfDirectSnapshot result)
        {
            var evidence = new IkfDirectContext { Context = context };
            result.Contexts.Add(evidence);
            object activated = null; IPropertyStoreRead store = null;
            IntPtr contextPointer = Marshal.AllocCoTaskMem(16);
            try
            {
                Marshal.StructureToPtr(new Guid(context), contextPointer, false);
                var activation = new PropVariant { Type = 72, Pointer = contextPointer };
                Guid iid = EffectsStoreIid;
                int hr = endpoint.Activate(ref iid, 1, ref activation, out activated);
                evidence.HResult = "0x" + hr.ToString("X8");
                Check(hr, "IMMDevice.Activate(IAudioSystemEffectsPropertyStore)");
                var effects = (IAudioSystemEffectsPropertyStoreRead)activated;
                hr = effects.OpenUserPropertyStore(0, out store);
                evidence.HResult = "0x" + hr.ToString("X8");
                Check(hr, "OpenUserPropertyStore(STGM_READ)");
                if (store == null) throw new InvalidOperationException("Windows returned a null user property store.");
                evidence.Status = "opened-read-only";
                foreach (var field in fields)
                {
                    if (field.Context != context) continue;
                    PropVariant value = default(PropVariant);
                    try
                    {
                        var key = new PropertyKey(new Guid(field.PropertyGuid), field.PropertyId);
                        int valueHr = store.GetValue(ref key, out value);
                        result.Values.Add(Decode(field, valueHr, value.Type, value.Dword));
                    }
                    catch (Exception error) { result.Values.Add(new IkfDirectValue { Property = field, Status = "read-error", Error = error.Message }); }
                    finally { PropVariantClear(ref value); }
                }
            }
            catch (Exception error)
            {
                evidence.Status = "unavailable"; evidence.Error = error.Message;
                foreach (var field in fields) if (field.Context == context) result.Values.Add(new IkfDirectValue { Property = field, Status = "context-unavailable", HResult = evidence.HResult, Error = error.Message });
            }
            finally { Release(store); Release(activated); Marshal.FreeCoTaskMem(contextPointer); }
        }

        private sealed class WindowsFamilyStore : IIkfDirectFamilyStore
        {
            private IMMDeviceEnumerator enumerator;
            private IMMDevice endpoint;
            private object activated;
            private IAudioSystemEffectsPropertyStoreRead effects;
            private IPropertyStoreRead writableOwner;
            private IPropertyStoreWrite writable;
            public IkfDirectSnapshot Identity { get; private set; }

            public WindowsFamilyStore(string endpointId, string context)
            {
                Identity = new IkfDirectSnapshot { EndpointId = endpointId, Flow = ValidateEndpointId(endpointId) };
                try
                {
                    enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                    Check(enumerator.GetDevice(endpointId, out endpoint), "IMMDeviceEnumerator.GetDevice");
                    AssertIdentity();
                    IntPtr pointer = Marshal.AllocCoTaskMem(16);
                    try
                    {
                        Marshal.StructureToPtr(new Guid(context), pointer, false);
                        var activation = new PropVariant { Type = 72, Pointer = pointer };
                        Guid iid = EffectsStoreIid;
                        Check(endpoint.Activate(ref iid, 1, ref activation, out activated), "IMMDevice.Activate(IAudioSystemEffectsPropertyStore)");
                        effects = (IAudioSystemEffectsPropertyStoreRead)activated;
                    }
                    finally { Marshal.FreeCoTaskMem(pointer); }
                }
                catch { Dispose(); throw; }
            }

            public void AssertIdentity()
            {
                uint state; Check(endpoint.GetState(out state), "IMMDevice.GetState");
                if ((state & 1) == 0) throw new InvalidOperationException("Only an active audio endpoint may be changed.");
                int flow; Check(((IMMEndpoint)endpoint).GetDataFlow(out flow), "IMMEndpoint.GetDataFlow");
                if ((flow == 0 ? "render" : flow == 1 ? "capture" : "unknown") != Identity.Flow) throw new InvalidOperationException("Audio endpoint flow changed.");
                try
                {
                    Identity.EndpointInstanceId = ReadInstanceId(endpoint);
                    Identity.IdentitySource = "PKEY_Device_InstanceId plus present PnP parent chain";
                }
                catch (Exception error)
                {
                    Identity.EndpointInstanceId = "SWD\\MMDEVAPI\\" + Identity.EndpointId;
                    Identity.IdentitySource = "Exact MMDEVAPI PnP endpoint node plus present PnP parent chain";
                    Identity.IdentityWarning = error.Message;
                }
                VerifyIdentity(Identity); Identity.IdentityVerified = true;
            }

            public List<IkfDirectValue> ReadFamily(IkfDirectProperty[] fields)
            {
                IPropertyStoreRead read = null;
                try
                {
                    Check(effects.OpenUserPropertyStore(0, out read), "OpenUserPropertyStore(STGM_READ)");
                    if (read == null) throw new InvalidOperationException("Windows returned a null read-only property store.");
                    var result = new List<IkfDirectValue>();
                    foreach (var field in fields)
                    {
                        PropVariant value = default(PropVariant);
                        try
                        {
                            var key = new PropertyKey(new Guid(field.PropertyGuid), field.PropertyId);
                            int hr = read.GetValue(ref key, out value);
                            result.Add(Decode(field, hr, value.Type, value.Dword));
                        }
                        finally { PropVariantClear(ref value); }
                    }
                    return result;
                }
                finally { Release(read); }
            }

            public void PrepareWrite()
            {
                writable = null; Release(writableOwner); writableOwner = null;
                Check(effects.OpenUserPropertyStore(2, out writableOwner), "OpenUserPropertyStore(STGM_READWRITE)");
                if (writableOwner == null) throw new InvalidOperationException("Windows returned a null writable property store.");
                // IPropertyStore's vtable contains SetValue and Commit after the three getter slots.
                writable = (IPropertyStoreWrite)writableOwner;
            }

            public void Write(IkfDirectProperty property, ushort variantType, uint rawDword)
            {
                if (writable == null) throw new InvalidOperationException("The read/write property store is not open.");
                var key = new PropertyKey(new Guid(property.PropertyGuid), property.PropertyId);
                var value = new PropVariant { Type = variantType, Dword = rawDword };
                Check(writable.SetValue(ref key, ref value), "IPropertyStore.SetValue(" + property.SdkProperty + ")");
            }

            public void Commit()
            {
                if (writable == null) throw new InvalidOperationException("The read/write property store is not open.");
                Check(writable.Commit(), "IPropertyStore.Commit");
            }

            public void Dispose()
            {
                writable = null; Release(writableOwner); writableOwner = null;
                effects = null; Release(activated); activated = null;
                Release(endpoint); endpoint = null; Release(enumerator); enumerator = null;
            }
        }

        private static void Check(int hr, string operation) { if (hr < 0) throw new COMException(operation + " failed (0x" + hr.ToString("X8") + ").", hr); }
        private static void CheckCr(uint cr, string operation) { if (cr != 0) throw new InvalidOperationException(operation + " failed (CONFIGRET 0x" + cr.ToString("X8") + ")."); }
        private static void Release(object instance) { if (instance != null && Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance); }

        [StructLayout(LayoutKind.Sequential)]
        private struct PropertyKey { public Guid Format; public uint Id; public PropertyKey(Guid format, uint id) { Format = format; Id = id; } }
        [StructLayout(LayoutKind.Explicit, Size = 24)]
        private struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public uint Dword; [FieldOffset(8)] public IntPtr Pointer; }
        [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Locate_DevNodeW(out uint node, string id, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Get_Device_IDW(uint node, StringBuilder buffer, int length, uint flags);
        [DllImport("cfgmgr32.dll", ExactSpelling = true)] private static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] private class MMDeviceEnumeratorComObject { }
        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice endpoint);
            [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
        }
        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, uint clsctx, ref PropVariant activation, [MarshalAs(UnmanagedType.IUnknown)] out object result);
            [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStoreRead store);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out uint state);
        }
        [ComImport, Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMEndpoint { [PreserveSig] int GetDataFlow(out int flow); }
        [ComImport, Guid("302AE7F9-D7E0-43E4-971B-1F8293613D2A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioSystemEffectsPropertyStoreRead
        {
            [PreserveSig] int OpenDefaultPropertyStore(uint access, out IPropertyStoreRead store);
            [PreserveSig] int OpenUserPropertyStore(uint access, out IPropertyStoreRead store);
        }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStoreRead
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStoreWrite
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
            [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
            [PreserveSig] int Commit();
        }
    }
}
