using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace PeripheralHub.Inphic
{
    // Official PSF is bounded INI text, not an object graph. Unknown fields and original order survive export.
    public sealed class OfficialPsfDocument
    {
        public const int MaximumBytes=1024*1024;
        private readonly List<string> lines;
        private readonly string newline;
        public string SourceKind { get {return "user-selected-official-local-profile";} }
        public bool IsHardwareReadback { get {return false;} }
        private OfficialPsfDocument(List<string> text,string lineEnding){lines=text;newline=lineEnding;}
        public static OfficialPsfDocument ParseBytes(byte[] bytes)
        {
            if(bytes==null || bytes.Length>MaximumBytes)throw new FormatException("PSF exceeds1MiB limit.");
            string text;
            if(bytes.Length>=2 && bytes[0]==255 && bytes[1]==254){if(bytes.Length%2!=0)throw new FormatException("Truncated UTF16 PSF.");text=new UnicodeEncoding(false,false,true).GetString(bytes,2,bytes.Length-2);}
            else if(bytes.Length>=2 && bytes[0]==254 && bytes[1]==255)throw new FormatException("Official UTF16LE or UTF8 text required.");
            else {int skip=bytes.Length>=3 && bytes[0]==239 && bytes[1]==187 && bytes[2]==191?3:0;text=new UTF8Encoding(false,true).GetString(bytes,skip,bytes.Length-skip);}
            return ParseText(text);
        }
        public static OfficialPsfDocument ParseText(string text)
        {
            if(text==null || text.Length>MaximumBytes/2 || text.IndexOf('\0')>=0)throw new FormatException("Invalid PSF text or size.");
            var lineEnding=text.IndexOf("\r\n",StringComparison.Ordinal)>=0?"\r\n":text.IndexOf('\r')>=0?"\r":"\n";
            var ls=text.TrimStart('\uFEFF').Replace("\r\n","\n").Replace('\r','\n').Split('\n').ToList();
            if(ls.Count>4096 || ls.Any(x=>x.Length>16384))throw new FormatException("PSF line limits exceeded.");
            int sections=0;bool setting=false;var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);int active=-1;
            foreach(string raw in ls){string l=raw.Trim();if(l.Length==0 || l.StartsWith(";") || l.StartsWith("#"))continue;
                if(l.StartsWith("[")){if(l!="[Setting]" || ++sections!=1)throw new FormatException("Exactly one official[Setting] section required.");setting=true;continue;}
                if(!setting)throw new FormatException("PSF field precedes[Setting].");int eq=l.IndexOf('=');if(eq<1)throw new FormatException("Malformed PSF line.");
                string k=l.Substring(0,eq).Trim();if(k.Length>128 || !Regex.IsMatch(k,@"^[A-Za-z][A-Za-z0-9_]*$"))throw new FormatException("Invalid PSF field name.");
                var m=Regex.Match(k,@"^(?:Key|MacroKey)([0-5])(?:Name|Value)$");if(m.Success)active=int.Parse(m.Groups[1].Value,CultureInfo.InvariantCulture);
                bool scoped=k.Equals("MacroActionNum",StringComparison.OrdinalIgnoreCase)||k.Equals("AllAction",StringComparison.OrdinalIgnoreCase)||k.Equals("MacroKeyIndex",StringComparison.OrdinalIgnoreCase);
                if(scoped && active<0)throw new FormatException("Macro field has no key scope.");string id=(scoped?active.ToString(CultureInfo.InvariantCulture)+":":"")+k;
                if(!seen.Add(id))throw new FormatException("Ambiguous duplicate PSF field: "+k);
            }
            if(sections!=1)throw new FormatException("Missing[Setting].");var doc=new OfficialPsfDocument(ls,lineEnding);doc.ValidateStoredFields();return doc;
        }
        private void ValidateStoredFields()
        {
            foreach(var e in Entries()){
                string k=e.Key,v=e.Value;
                if(Regex.IsMatch(k,@"^(XYSetting[1-8]Value|DPIOffOnFlagValue|CurrentDPILevelValue|AngleSnapValue|LiftDetectionValue)$",RegexOptions.IgnoreCase)) {
                    uint n; if(v.Length<2 || v.Length>4 || !uint.TryParse(v,NumberStyles.HexNumber,CultureInfo.InvariantCulture,out n))throw new FormatException("Invalid hex scalar: "+k);
                    if(!k.StartsWith("XY",StringComparison.OrdinalIgnoreCase)&&n>255)throw new FormatException("Byte overflow: "+k);
                }
                if(Regex.IsMatch(k,@"^(Key[0-5]Value|PollingRateValue|Lighting[12]ModeValue)$",RegexOptions.IgnoreCase) && In9Codec.Unhex(v).Length!=3)throw new FormatException("Expected three-byte tuple: "+k);
                if(Regex.IsMatch(k,@"^DPILevelIndication[0-7]Valuer$",RegexOptions.IgnoreCase))Color(v);
                if(k.Equals("AllAction",StringComparison.OrdinalIgnoreCase) && In9Codec.Unhex(v).Length!=1344)throw new FormatException("Official AllAction must hold336 four-byte records.");
                if(k.Equals("MacroActionNum",StringComparison.OrdinalIgnoreCase)){int n=Decimal(v);if(n<0 || n>336)throw new FormatException("Macro record count out of bounds.");}
                if(k.Equals("PowerDownTime",StringComparison.OrdinalIgnoreCase)||k.Equals("KeyDebounce",StringComparison.OrdinalIgnoreCase)){int n=Decimal(v);if(n<0||n>255)throw new FormatException("Protocol byte overflow: "+k);}
                if(k.Equals("MoveLightingOnOffMode",StringComparison.OrdinalIgnoreCase)||k.Equals("MotionWakeup",StringComparison.OrdinalIgnoreCase)){int n=Decimal(v);if(n!=0&&n!=1)throw new FormatException("Invalid boolean: "+k);}
            }
        }
        private IEnumerable<KeyValuePair<string,string>> Entries()
        {
            foreach(string raw in lines){string x=raw.Trim();if(x.StartsWith(";")||x.StartsWith("#")||x.StartsWith("["))continue;int eq=x.IndexOf('=');if(eq>0)yield return new KeyValuePair<string,string>(x.Substring(0,eq).Trim(),x.Substring(eq+1));}
        }
        public string Get(string name)
        {
            var found=Entries().Where(x=>string.Equals(x.Key,name,StringComparison.OrdinalIgnoreCase)).ToArray();
            if(found.Length>1)throw new InvalidOperationException("Use key-scoped macro access for repeated fields.");return found.Length==0?null:found[0].Value;
        }
        public string GetKeyField(int key,string name)
        {
            if(key<0||key>5)throw new ArgumentOutOfRangeException("key");int active=-1;
            foreach(var e in Entries()){var m=Regex.Match(e.Key,@"^(?:Key|MacroKey)([0-5])(?:Name|Value)$");if(m.Success)active=int.Parse(m.Groups[1].Value,CultureInfo.InvariantCulture);if(active==key&&e.Key.Equals(name,StringComparison.OrdinalIgnoreCase))return e.Value;}return null;
        }
        public void Set(string name,string value)
        {
            if(name==null || value==null || value.IndexOfAny(new[]{'\r','\n','\0'})>=0 || !Regex.IsMatch(name,@"^[A-Za-z][A-Za-z0-9_]*$"))throw new ArgumentException("Invalid field.");
            if(name.Equals("AllAction",StringComparison.OrdinalIgnoreCase)||name.Equals("MacroActionNum",StringComparison.OrdinalIgnoreCase)||name.Equals("MacroKeyIndex",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Use SetMacro for scoped fields.");
            int at=-1;for(int i=0;i<lines.Count;i++){string l=lines[i].Trim();int eq=l.IndexOf('=');if(eq>0 && l.Substring(0,eq).Trim().Equals(name,StringComparison.OrdinalIgnoreCase)){if(at>=0)throw new FormatException("Duplicate field.");at=i;}}
            var copy=new List<string>(lines);if(at<0){at=copy.Count;copy.Add(name+"="+value);}else copy[at]=name+"="+value;
            var checkedDoc=ParseText(string.Join("\r\n",copy));lines.Clear();lines.AddRange(checkedDoc.lines);
        }
        public void SetDpi3325(byte sensor,byte mask,int enabledOrdinal,int[] eightDpis)
        {
            if(eightDpis==null||eightDpis.Length!=8)throw new ArgumentException("PSF requires eight preserved slot values.");In9Codec.ResolveEnabledSlot(mask,enabledOrdinal);
            var copy=ParseText(ExportText());copy.Set("DPIOffOnFlagValue",mask.ToString("X2"));copy.Set("CurrentDPILevelValue",enabledOrdinal.ToString("X2"));for(int i=0;i<8;i++)copy.Set("XYSetting"+(i+1)+"Value",In9Codec.DpiToPsfIndex(sensor,eightDpis[i]).ToString("X2"));lines.Clear();lines.AddRange(copy.lines);
        }
        public void SetMacro(int key,string macroName,int recordCount,byte[] allAction)
        {
            if(key<0||key>5||macroName==null||macroName.IndexOfAny(new[]{'\r','\n','\0'})>=0||allAction==null||allAction.Length!=1344||recordCount<0||recordCount>336)throw new ArgumentException("Invalid macro storage.");
            var copy=new List<string>(lines);int active=-1;var replaced=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for(int i=0;i<copy.Count;i++){string l=copy[i].Trim();int eq=l.IndexOf('=');if(eq<1)continue;string k=l.Substring(0,eq).Trim();var m=Regex.Match(k,@"^(?:Key|MacroKey)([0-5])(?:Name|Value)$");if(m.Success)active=int.Parse(m.Groups[1].Value,CultureInfo.InvariantCulture);if(active!=key)continue;
                if(k.Equals("MacroKey"+key+"Name",StringComparison.OrdinalIgnoreCase)){copy[i]=k+"="+macroName;replaced.Add("name");}
                if(k.Equals("MacroActionNum",StringComparison.OrdinalIgnoreCase)){copy[i]=k+"="+recordCount;replaced.Add("count");}
                if(k.Equals("AllAction",StringComparison.OrdinalIgnoreCase)){copy[i]=k+"="+In9Codec.Hex(allAction);replaced.Add("data");}
            }
            if(replaced.Count!=3)throw new FormatException("Existing complete macro scope required.");var doc=ParseText(string.Join("\r\n",copy));lines.Clear();lines.AddRange(doc.lines);
        }
        public void StageHubMacro(int key,string macroName,In9HubMacroEvent[] events,byte slot,byte repeatMode,byte repeatCount)
        {
            if(key<0 || key>5 || string.IsNullOrWhiteSpace(macroName) || macroName.Length>60 || macroName.IndexOfAny(new[]{'\r','\n','\0'})>=0)throw new ArgumentException("An explicit key0..5 and macro name1..60 are required.");
            byte[] tuple=In9Codec.MacroBinding(slot,repeatMode,repeatCount);
            var copy=ParseText(ExportText());
            for(int i=0;i<6;i++)if(i!=key){byte[] other=In9Codec.Unhex(copy.Required("Key"+i+"Value"));if(other[0]==0x90 && (other[1]&15)==slot)throw new ArgumentException("The selected macro slot is already used by another key.");}
            In9StoredMacro storage=In9Codec.BuildStoredMacroFromHubEvents(events);
            copy.SetMacro(key,macroName,storage.RecordCount,storage.AllAction);
            copy.Set("Key"+key+"Name",macroName);copy.Set("Key"+key+"Value",In9Codec.Hex(tuple));
            // Validate the complete upload-before-bind plan, including the primary-button guard,
            // before committing any local document mutation.
            In9ApplyPlan.FromOfficialPsf(copy,In9Codec.Sensor3325,0,new[]{"macros","buttons"});
            lines.Clear();lines.AddRange(copy.lines);
        }
        public string ExportText(){return string.Join(newline,lines);}
        public byte[] ExportUtf16Le()
        {
            byte[] p=new UnicodeEncoding(false,false,true).GetBytes(ExportText());var b=new byte[p.Length+2];b[0]=255;b[1]=254;Buffer.BlockCopy(p,0,b,2,p.Length);return b;
        }
        // Exact current executable loader reads20 property rows POSITIONALLY before DPI.
        // Old bundled defaults have17 rows; normal roundtrip preserves them, this strict exporter
        // requires all20 explicit values and six explicit host macro library indices.
        public byte[] ExportOfficialCompatibleUtf16Le(int[] macroLibraryIndices)
        {
            if(macroLibraryIndices==null||macroLibraryIndices.Length!=6||macroLibraryIndices.Any(x=>x<0))throw new ArgumentException("Six explicit nonnegative macro-library indices required.");
            string[] header={"ProfileName","GameFile0","GameFile1","GameFile2","DoubleClickSpeed","PointerSpeed","AccelerationEnable","ScrollWheelSpeed","ScrollWheelPageEnable","TiltSpeed","Sensitivity_X","Sensitivity_Y","XYSynchronous","X_DPI","Y_DPI","MoveLightingOnOffMode","PowerDownTime","LiftDetectionHeight","KeyDebounce","MotionWakeup"};
            var output=new List<string>{"[Setting]"};var used=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Action<string> emit=k=>{output.Add(k+"="+Required(k));used.Add(k);};foreach(string k in header)emit(k);
            emit("DPIOffOnFlagValue");for(int i=1;i<=8;i++)emit("XYSetting"+i+"Value");emit("CurrentDPILevelValue");for(int i=0;i<8;i++)emit("DPILevelIndication"+i+"Valuer");emit("AngleSnapValue");emit("LiftDetectionValue");emit("PollingRateName");emit("PollingRateValue");
            foreach(string k in new[]{"Lighting1Name","Lighting1ModeValue","Lighting1OffOn","Lighting1Speed","Lighting1Brightness","Lighting1ColorSelected","Lighting1FixedColor","Lighting1Direction","Lighting2Name","Lighting2ModeValue","Lighting2OffOn","Lighting2Speed","Lighting2Brightness","Lighting2FixedColor"})emit(k);
            for(int i=0;i<6;i++){
                emit("Key"+i+"Name");emit("Key"+i+"Value");output.Add("MacroKeyIndex="+macroLibraryIndices[i]);emit("MacroKey"+i+"Name");
                string count=GetKeyField(i,"MacroActionNum"),data=GetKeyField(i,"AllAction");if(count==null||data==null)throw new FormatException("Complete key-scoped macro fields required.");output.Add("MacroActionNum="+count);output.Add("AllAction="+data);
            }
            foreach(var e in Entries())if(!used.Contains(e.Key)&&e.Key!="MacroKeyIndex"&&e.Key!="MacroActionNum"&&e.Key!="AllAction")output.Add(e.Key+"="+e.Value);
            return ParseText(string.Join("\r\n",output)+"\r\n").ExportUtf16Le();
        }
        public In9Profile Decode3325(byte observedSensor)
        {
            byte mask=HexByte(Required("DPIOffOnFlagValue"));int ordinal=HexByte(Required("CurrentDPILevelValue"));In9Codec.ResolveEnabledSlot(mask,ordinal);
            var dpis=new int[8];var colors=new int[8];for(int i=0;i<8;i++){dpis[i]=In9Codec.PsfIndexToDpi(observedSensor,ushort.Parse(Required("XYSetting"+(i+1)+"Value"),NumberStyles.HexNumber,CultureInfo.InvariantCulture));colors[i]=Color(Required("DPILevelIndication"+i+"Valuer"));}
            byte[] rate=In9Codec.Unhex(Required("PollingRateValue"));if(rate.Length!=3||rate[1]!=0||rate[2]!=0)throw new NotSupportedException("Unsupported polling tuple flags.");
            var keys=new byte[6][];for(int i=0;i<6;i++)keys[i]=In9Codec.Unhex(Required("Key"+i+"Value"));
            return new In9Profile{EnabledMask=mask,CurrentEnabledOrdinal=ordinal,DpiSlots=dpis,DpiColorsRgb=colors,PollingRateHz=In9Codec.RateFromPsfIndex(rate[0]),KeyTriples=keys,PowerDownTimeRaw=NullableByteDecimal("PowerDownTime"),KeyDebounceRaw=NullableByteDecimal("KeyDebounce"),MoveClosesLight=NullableBool("MoveLightingOnOffMode"),MotionWakeup=NullableBool("MotionWakeup"),Light=DecodeLight()};
        }
        private In9LightProfile DecodeLight()
        {
            byte[] mode=In9Codec.Unhex(Required("Lighting1ModeValue"));if(mode[1]!=0||mode[2]!=0)throw new NotSupportedException("Unsupported lighting tuple flags.");
            int m=mode[0];if(m>9)throw new NotSupportedException("Unknown official lighting mode.");
            var speed=Pipe(Required("Lighting1Speed"));var brightness=Pipe(Required("Lighting1Brightness"));if(speed.Length!=10||brightness.Length!=10)throw new FormatException("Ten per-mode level fields required.");
            byte enabled=HexByte(Required("Lighting1OffOn"));if(enabled>1)throw new FormatException("Invalid lighting enabled flag.");
            string direction=Get("Lighting1Direction");var dirs=direction==null?null:Pipe(direction);byte d=0;if(m==1){if(dirs==null||dirs.Length!=10)throw new FormatException("Per-mode direction required.");d=dirs[m];}
            int[] colors=new int[0];if(m==2||m==3||m==6||m==7){
                string[] rows=Required("Lighting1FixedColor").Split(new[]{';'},StringSplitOptions.RemoveEmptyEntries);if(rows.Length!=10)throw new FormatException("Ten lighting color rows required.");var row=rows[m].Split('|').Select(Color).ToArray();if(row.Length!=10)throw new FormatException("Ten lighting color columns required.");
                string[] selRows=Required("Lighting1ColorSelected").Split(new[]{';'},StringSplitOptions.RemoveEmptyEntries);if(selRows.Length!=10)throw new FormatException("Ten selection rows required.");var sel=Pipe(selRows[m]);if(sel.Length!=10||sel.Any(x=>x>1))throw new FormatException("Invalid selection matrix.");
                if(m==2)colors=Enumerable.Range(0,7).Where(i=>sel[i]!=0&&row[i]!=0).Select(i=>row[i]).ToArray();
                else {int n=m==3?1:m==6?7:2;colors=Enumerable.Range(0,n).Select(i=>m==3||sel[i]!=0?row[i]:0).ToArray();}
            }
            return new In9LightProfile{Mode=mode[0],Enabled=enabled!=0,SpeedIndex=speed[m],BrightnessIndex=brightness[m],Direction=d,ColorsRgb=colors};
        }
        private string Required(string k){string x=Get(k);if(x==null)throw new FormatException("Required PSF field missing: "+k);return x;}
        private byte? NullableByteDecimal(string k){string x=Get(k);return x==null?(byte?)null:checked((byte)Decimal(x));}
        private bool? NullableBool(string k){byte? b=NullableByteDecimal(k);return b.HasValue?(bool?)(b==1):null;}
        private static byte HexByte(string x){return byte.Parse(x,NumberStyles.HexNumber,CultureInfo.InvariantCulture);}
        private static int Decimal(string x){return int.Parse(x,NumberStyles.Integer,CultureInfo.InvariantCulture);}
        private static int Color(string x){if(x.Length!=6)throw new FormatException("Expected six RGB digits.");return int.Parse(x,NumberStyles.HexNumber,CultureInfo.InvariantCulture);}
        private static byte[] Pipe(string x){return x.Split('|').Select(HexByte).ToArray();}
    }
    public sealed class In9LightProfile
    {
        public byte Mode {get;set;} public bool Enabled {get;set;} public byte SpeedIndex {get;set;} public byte BrightnessIndex {get;set;} public byte Direction {get;set;} public int[] ColorsRgb {get;set;}
    }
    public sealed class In9Profile
    {
        public string SourceKind {get{return "user-selected-official-local-profile";}} public bool IsHardwareReadback {get{return false;}}
        public byte EnabledMask {get;set;} public int CurrentEnabledOrdinal {get;set;} public int[] DpiSlots {get;set;} public int[] DpiColorsRgb {get;set;} public int PollingRateHz {get;set;} public byte[][] KeyTriples {get;set;}
        public byte? PowerDownTimeRaw {get;set;} public byte? KeyDebounceRaw {get;set;} public bool? MoveClosesLight {get;set;} public bool? MotionWakeup {get;set;} public In9LightProfile Light {get;set;}
    }
}
