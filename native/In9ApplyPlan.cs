using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace PeripheralHub.Inphic
{
    // Immutable snapshots returned to a transport owner; constructing a plan never sends it.
    public sealed class In9PlannedPacket
    {
        private readonly byte[] bytes;
        public string Domain {get;private set;}
        public string Evidence {get{return In9Codec.Evidence;}}
        public bool HasSettingsReadback {get{return false;}}
        public int SuggestedPostSendDelayMilliseconds {get{return 60;}}
        public byte[] Bytes {get{return (byte[])bytes.Clone();}}
        internal In9PlannedPacket(string domain,byte[] frame){Domain=domain;bytes=(byte[])frame.Clone();}
    }
    public sealed class In9ApplyPlan
    {
        public string BaselineKind {get{return "explicitly-selected-desired-profile";}}
        public bool IsOriginalHardwareBackup {get{return false;}}
        public bool CanVerifyCompleteHardwareState {get{return false;}}
        public byte NextSequence {get;private set;}
        public IReadOnlyList<In9PlannedPacket> Packets {get;private set;}
        private In9ApplyPlan(List<In9PlannedPacket> packets,byte next){Packets=packets.AsReadOnly();NextSequence=next;}
        // Domains are explicit; no missing PSF value is replaced by constructor defaults.
        public static In9ApplyPlan FromOfficialPsf(OfficialPsfDocument doc,byte observedSensor,byte firstSequence,string[] domains)
        {
            if(doc==null||domains==null||domains.Length==0)throw new ArgumentException("Explicit PSF and domains required.");
            var allowed=new HashSet<string>(new[]{"dpi","dpiColors","polling","lighting","buttons","macros","debounce","power","motion","lift"},StringComparer.Ordinal);
            var wanted=new HashSet<string>(StringComparer.Ordinal);foreach(string d in domains)if(!allowed.Contains(d)||!wanted.Add(d))throw new ArgumentException("Unknown or duplicate domain.");
            In9Profile p=doc.Decode3325(observedSensor);var packets=new List<In9PlannedPacket>();byte seq=firstSequence;
            // Validate selected macro/binding domains before constructing upload packets. The raw
            // tuple's low nibble is the wire slot; MacroKeyIndex is only a host library identity.
            if(wanted.Contains("macros")||wanted.Contains("buttons"))foreach(byte[] triple in p.KeyTriples)if(triple[0]==0x90)In9Codec.MacroBinding((byte)(triple[1]&15),(byte)(triple[1]>>4),triple[2]);
            Action<string,byte[]> add=(domain,frame)=>{packets.Add(new In9PlannedPacket(domain,frame));seq=unchecked((byte)(seq+1));};
            // Upload content before binding a button. Slots come only from explicit raw90 key tuples.
            if(wanted.Contains("macros")){
                var slots=new HashSet<byte>();
                for(int i=0;i<6;i++)if(p.KeyTriples[i][0]==0x90){byte slot=(byte)(p.KeyTriples[i][1]&15);if(!slots.Add(slot))throw new NotSupportedException("Two macro keys share a slot; choose unique explicit slot identities before planning.");
                    string count=doc.GetKeyField(i,"MacroActionNum"),data=doc.GetKeyField(i,"AllAction");if(count==null||data==null)throw new FormatException("Macro binding has no complete PSF storage.");
                    var stream=In9Codec.StoredMacroToActionStream(In9Codec.Unhex(data),int.Parse(count,NumberStyles.Integer,CultureInfo.InvariantCulture));foreach(byte[] b in In9Codec.BuildMacroFrames(seq,slot,stream))add("macros",b);
                }
            }
            if(wanted.Contains("dpi"))add("dpi",In9Codec.BuildDpi3325(seq,observedSensor,p.EnabledMask,p.CurrentEnabledOrdinal,p.DpiSlots.Take(6).ToArray()));
            if(wanted.Contains("dpiColors"))add("dpiColors",In9Codec.BuildDpiColors(seq,p.DpiColorsRgb));
            if(wanted.Contains("polling"))add("polling",In9Codec.BuildPollingRate(seq,p.PollingRateHz));
            if(wanted.Contains("lighting")){
                // OffOn field is not consumed in the traced sender. Do not invent an off transform.
                if(!p.Light.Enabled && p.Light.Mode!=0)throw new NotSupportedException("LightingOffOn=false with nonzero mode has no proved TX transform; explicitly select mode0 to send known mode0 bytes.");
                add("lighting",In9Codec.BuildLighting(seq,p.Light.Mode,p.Light.SpeedIndex,p.Light.BrightnessIndex,p.Light.Direction,p.Light.ColorsRgb));
            }
            if(wanted.Contains("debounce")){if(!p.KeyDebounceRaw.HasValue)throw new FormatException("KeyDebounce must be explicitly supplied; no default is inferred.");add("debounce",In9Codec.BuildDebounceRaw(seq,p.KeyDebounceRaw.Value));}
            if(wanted.Contains("power")){if(!p.PowerDownTimeRaw.HasValue||!p.MoveClosesLight.HasValue)throw new FormatException("PowerDownTime and MoveLightingOnOffMode must be explicit.");add("power",In9Codec.BuildSleepRaw(seq,p.PowerDownTimeRaw.Value,p.MoveClosesLight.Value));}
            if(wanted.Contains("motion")){if(!p.MotionWakeup.HasValue)throw new FormatException("MotionWakeup must be explicit.");add("motion",In9Codec.BuildMotionWakeup(seq,p.MotionWakeup.Value));}
            if(wanted.Contains("lift")){string raw=doc.Get("LiftDetectionHeight");if(raw==null)throw new FormatException("LiftDetectionHeight decimal field required; legacy LiftDetectionValue is not substituted.");add("lift",In9Codec.BuildLiftDetection(seq,int.Parse(raw,CultureInfo.InvariantCulture)));}
            if(wanted.Contains("buttons")){
                if(!p.KeyTriples.Any(x=>x.SequenceEqual(new byte[]{16,1,0})))throw new ArgumentException("A primary mouse button must remain assigned.");
                if(p.KeyTriples.Any(x=>x[0]==0x90)&&!wanted.Contains("macros"))throw new ArgumentException("A PSF macro binding requires content in the same plan.");
                for(int i=0;i<6;i++)add("buttons",In9Codec.BuildPsfButton(seq,i,p.KeyTriples[i]));
            }
            return new In9ApplyPlan(packets,seq);
        }
    }
}
