using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace PeripheralHub.Inphic
{
    public sealed class In9StoredMacro { public int RecordCount {get;set;} public byte[] AllAction {get;set;} }
    public sealed class In9HubMacroEvent
    {
        public string Kind {get;set;} public int Code {get;set;} public int Duration {get;set;}
        public string Unit {get;set;} public string Button {get;set;} public int X {get;set;} public int Y {get;set;}
    }
    // Pure codec for SHA256 8DB0F8B4BBF818F299B6C7131E4B4B94C9168846AEB9FD65347866D11BC502BC.
    // No HID/file IO, vendor execution, unsafe deserialization or fabricated setting readback.
    public static partial class In9Codec
    {
        public const int ReportLength = 33;
        public const byte Sensor3325 = 0x25;
        public const string Evidence = "official-executable-static; hardware-effect-validation-required";
        private static byte[] Frame(byte command, byte sequence, byte[] payload, byte block = 1)
        {
            if(payload == null || payload.Length > 26) throw new ArgumentException("Payload exceeds 26 bytes.");
            var b=new byte[33]; b[0]=12;b[1]=1;b[2]=command;b[4]=sequence;b[5]=block;b[6]=(byte)payload.Length;
            Buffer.BlockCopy(payload,0,b,7,payload.Length);return b;
        }
        public static int[] DpiOptions3325()
        {
            var x=new List<int>();for(int i=200;i<=5000;i+=100)x.Add(i);
            x.AddRange(new[]{5500,6000,6400,7000,7500,8000,8500,9000,9500,10000});return x.ToArray();
        }
        public static ushort DpiToPsfIndex(byte sensor,int dpi)
        {
            if(sensor!=37)throw new NotSupportedException("Only the traced sensor3325 table is supported.");
            int i=Array.IndexOf(DpiOptions3325(),dpi);if(i<0)throw new ArgumentOutOfRangeException("dpi","An exact supported DPI is required.");return (ushort)i;
        }
        public static int PsfIndexToDpi(byte sensor,ushort index)
        {
            if(sensor!=37)throw new NotSupportedException("Only sensor3325 is supported.");
            var t=DpiOptions3325();if(index>=t.Length)throw new ArgumentOutOfRangeException("index");return t[index];
        }
        public static int ResolveEnabledSlot(byte mask,int enabledOrdinal)
        {
            if(mask==0 || (mask&192)!=0 || enabledOrdinal<0)throw new ArgumentOutOfRangeException("mask/ordinal");
            int n=0;for(int i=0;i<6;i++)if((mask&(1<<i))!=0 && n++==enabledOrdinal)return i;
            throw new ArgumentOutOfRangeException("enabledOrdinal");
        }
        public static byte[] BuildDpi3325(byte sequence,byte sensor,byte mask,int currentEnabledOrdinal,int[] sixDpis)
        {
            if(sixDpis==null || sixDpis.Length!=6)throw new ArgumentException("All six slots, including disabled slots, are required.");
            ResolveEnabledSlot(mask,currentEnabledOrdinal);int count=0;for(int i=0;i<6;i++)if((mask&(1<<i))!=0)count++;
            var p=new byte[18];p[0]=(byte)(((currentEnabledOrdinal+1)<<4)|count);p[1]=mask;
            for(int i=0;i<6;i++){ushort r=(ushort)(DpiToPsfIndex(sensor,sixDpis[i])+1);p[2+i*2]=(byte)r;p[3+i*2]=(byte)(r>>8);}
            return Frame(5,sequence,p);
        }
        public static int RateFromPsfIndex(byte index){if(index>3)throw new ArgumentOutOfRangeException("index");return new[]{125,250,500,1000}[index];}
        public static byte RateToPsfIndex(int hz){int i=Array.IndexOf(new[]{125,250,500,1000},hz);if(i<0)throw new ArgumentOutOfRangeException("hz");return (byte)i;}
        public static byte[] BuildPollingRate(byte sequence,int hz)
        {
            byte[] c={8,4,2,1};return Frame(7,sequence,new[]{c[RateToPsfIndex(hz)]});
        }
        // PSF formats a COLORREF's low/mid/high bytes in that order: text RRGGBB -> wire R,G,B.
        public static byte[] BuildDpiColors(byte sequence,int[] eightColorsRgb)
        {
            if(eightColorsRgb==null || eightColorsRgb.Length!=8)throw new ArgumentException("Eight indicator colors are required.");
            var p=new byte[24];for(int i=0;i<8;i++)Rgb(p,i*3,eightColorsRgb[i]);return Frame(6,sequence,p);
        }
        private static void Rgb(byte[] dest,int start,int rgb)
        {
            if(rgb<0 || rgb>0xFFFFFF)throw new ArgumentOutOfRangeException("rgb");
            dest[start]=(byte)(rgb>>16);dest[start+1]=(byte)(rgb>>8);dest[start+2]=(byte)rgb;
        }
        // mode IDs are exact binary IDs, not inferred from translated display names.
        // speed/brightness are PSF UI indices: speed+1 in low nibble; brightness+1 in high nibble.
        public static byte[] BuildLighting(byte sequence,byte mode,byte speedIndex,byte brightnessIndex,byte direction,int[] colorsRgb)
        {
            if(mode>9 || speedIndex>14 || brightnessIndex>14)throw new ArgumentOutOfRangeException("mode/level");
            if(colorsRgb==null)colorsRgb=new int[0];int required=0,len=2;
            switch(mode){case 1:len=3;break;case 2:if(colorsRgb.Length>7)throw new ArgumentException("Mode2 supports at most seven selected nonblack colors.");required=colorsRgb.Length;len=3+3*required;break;case 3:required=1;len=5;break;case 6:required=7;len=23;break;case 7:required=2;len=8;break;}
            if(colorsRgb.Length!=required)throw new ArgumentException("Unexpected number of colors for this mode.");
            var p=new byte[len];p[0]=mode;p[1]=(byte)(((brightnessIndex+1)<<4)|(speedIndex+1));
            if(mode==1){if(direction>1)throw new ArgumentOutOfRangeException("direction");p[2]=direction;}
            if(mode==2){p[2]=(byte)required;for(int i=0;i<required;i++){if(colorsRgb[i]==0)throw new ArgumentException("Official mode2 omits black colors.");Rgb(p,3+i*3,colorsRgb[i]);}}
            if(mode==3 || mode==6 || mode==7)for(int i=0;i<required;i++)Rgb(p,2+i*3,colorsRgb[i]);
            return Frame(8,sequence,p);
        }
        // Literal protocol scalars: units/ranges must come from the target model's UI metadata.
        public static byte[] BuildDebounceRaw(byte sequence,byte keyDebounce){return Frame(10,sequence,new[]{keyDebounce});}
        public static byte[] BuildSleepRaw(byte sequence,byte powerDownTime,bool moveClosesLight){return Frame(11,sequence,new[]{powerDownTime,(byte)(moveClosesLight?1:0)});}
        public static byte[] BuildMotionWakeup(byte sequence,bool enabled){return Frame(12,sequence,new[]{(byte)(enabled?1:0)});}
        public static byte[] BuildLiftDetection(byte sequence,int heightCode)
        {
            if(heightCode!=1 && heightCode!=2)throw new ArgumentOutOfRangeException("heightCode");return Frame(9,sequence,new[]{(byte)heightCode,(byte)0});
        }
        public static int PsfKeyToWireSlot(int profileIndex)
        {
            if(profileIndex<0 || profileIndex>5)throw new ArgumentOutOfRangeException("profileIndex");return profileIndex==3?4:profileIndex==4?3:profileIndex;
        }
        // Three bytes are explicit target-protocol values. No public protocol function table is assumed.
        public static byte[] BuildButtonRaw(byte sequence,int wireSlot,byte[] triple)
        {
            if(wireSlot<0 || wireSlot>5 || triple==null || triple.Length!=3)throw new ArgumentException("Wire slot0..5 and exactly three function bytes required.");
            if(triple[0]==0x90)MacroBinding((byte)(triple[1]&15),(byte)(triple[1]>>4),triple[2]);
            if(triple[0]==0x70)KeyboardBinding(triple[2],triple[1]);
            if(triple[0]==0x30)RapidFireBinding(triple[1],triple[2]);
            if(triple[0]==0x50){if(triple[2]!=0)throw new ArgumentException("Unproved DPI-lock flags.");DpiLockBinding((triple[1]+1)*100);}
            return Frame(4,sequence,new[]{(byte)wireSlot,triple[0],triple[1],triple[2]});
        }
        public static byte[] BuildPsfButton(byte sequence,int profileIndex,byte[] triple){return BuildButtonRaw(sequence,PsfKeyToWireSlot(profileIndex),triple);}
        public static byte[] MouseButton(byte mask)
        {
            if(mask!=1 && mask!=2 && mask!=4 && mask!=8 && mask!=16)throw new ArgumentOutOfRangeException("mask");return new[]{(byte)16,mask,(byte)0};
        }
        public static byte[] DpiCycle(){return new byte[]{64,1,0};}
        // Official combo dialog VA437BE0/437C2A/437C50/437C76/437C9C:
        // 70, generic Ctrl|Shift|Alt|Win mask, keyboard usage from VA620238.
        // The exact256-byte combo table equals the macro table VA620138 in this executable.
        public static byte[] KeyboardBinding(byte usage,byte modifiers)
        {
            if(modifiers>15 || usage==0 || usage>=224 || Array.IndexOf(OfficialKeyTranslation,usage)<0)throw new ArgumentException("A keyboard usage from the official combo table and Ctrl/Shift/Alt/Win mask0..15 are required.");
            return new[]{(byte)0x70,modifiers,usage};
        }
        // Official fire dialog VA44F6F6/44F717/44F73D; Lan171/172 bounds.
        // The interval is kept as the official raw code, not relabelled as milliseconds.
        public static byte[] RapidFireBinding(byte interval,byte count)
        {
            if(interval<5)throw new ArgumentException("Official fire interval must be5..255; count0..255, with0 meaning while held.");
            return new[]{(byte)0x30,interval,count};
        }
        // Official submenu IDs1..11 use table62037F and labels200..1200,
        // initialized at406192..40625D and serialized at464552..46456C.
        public static byte[] DpiLockBinding(int dpi)
        {
            if(dpi<200 || dpi>1200 || dpi%100!=0)throw new ArgumentException("Choose an exact official DPI-lock option200..1200 in100-DPI increments.");
            return new[]{(byte)0x50,(byte)(dpi/100-1),(byte)0};
        }
        // Official dialog: mode1=until key release, mode4=until any key press,
        // mode2=count1..255. VA456002/4560C6 maps flags2000/4000/8000 to1/4/2;
        // VA42EF84 packs mode<<4|slot and emits count only for mode2. Mode0 is unproved.
        public static byte[] MacroBinding(byte slot,byte repeatMode,byte repeatCount)
        {
            if(slot>15 || (repeatMode!=1 && repeatMode!=2 && repeatMode!=4) || (repeatMode==2 && repeatCount==0) || (repeatMode!=2 && repeatCount!=0))throw new ArgumentException("Macro slot0..15, official mode1/2/4 and a count1..255 only for mode2 are required.");
            return new[]{(byte)0x90,(byte)((repeatMode<<4)|slot),repeatCount};
        }
        // Low level stream API accepts only validated local 3-byte actions. It is not an AllAction uploader.
        public static byte[][] BuildMacroFrames(byte firstSequence,byte slot,byte[] actionStream)
        {
            if(slot>15 || actionStream==null || actionStream.Length%3!=0 || actionStream.Length>375)throw new ArgumentException("Macro slot0..15, 0..125 validated actions required.");
            for(int i=0;i<actionStream.Length;i+=3){int k=actionStream[i]&0x70;if(k<0x10 || k>0x60)throw new ArgumentException("Unsupported macro action class.");}
            int blocks=Math.Max(1,(actionStream.Length+24)/25);var result=new byte[blocks][];
            for(int i=0;i<blocks;i++){int n=Math.Min(25,actionStream.Length-i*25);var p=new byte[1+n];p[0]=slot;if(n>0)Buffer.BlockCopy(actionStream,i*25,p,1,n);result[i]=Frame(14,unchecked((byte)(firstSequence+i)),p,(byte)((i<<4)|blocks));}
            return result;
        }
        // Official PSF AllAction is exactly336 records x4 bytes, in stored byte order.
        // Byte0=official key/03 delay; byte1 bit7=release; delay record bytes1..3 are big endian ms.
        public static byte[] StoredMacroToActionStream(byte[] allAction,int recordCount)
        {
            if(allAction==null || allAction.Length!=1344 || recordCount<0 || recordCount>336)throw new ArgumentException("Expected fixed1344-byte PSF macro storage and record count0..336.");
            var result=new List<byte>();
            for(int i=0;i<recordCount;i++){
                int o=i*4;byte vk=allAction[o];if(vk==3){if(i==0 || allAction[o-4]==3)throw new NotSupportedException("Leading or consecutive delay records cannot be represented without loss.");continue;}
                if((allAction[o+1]&0x7F)!=0)throw new NotSupportedException("Unsupported macro action flags.");
                byte mapped=OfficialKeyTranslation[vk];if(mapped==0)throw new NotSupportedException("Unmapped official macro key at record "+i.ToString(CultureInfo.InvariantCulture));
                int delay=0;if(i+1<recordCount && allAction[o+4]==3)delay=(allAction[o+5]<<16)|(allAction[o+6]<<8)|allAction[o+7];
                // Original truncates to0xFFF; production API rejects silent loss.
                if(delay>4095)throw new ArgumentOutOfRangeException("allAction","Delay exceeds local12-bit wire capacity; split explicitly in editor.");
                byte kind,key; if(mapped<0x91){kind=0x30;key=mapped;}
                else if(mapped<0xE8){kind=0x20;key=(byte)(1<<(mapped&7));}
                else if(mapped>=0xF0 && mapped<=0xF4){kind=0x10;key=(byte)(1<<(mapped&7));}
                else if(mapped==0xF5 || mapped==0xF6 || mapped==0xF7){
                    sbyte delta=unchecked((sbyte)allAction[o+3]);
                    if(allAction[o+1]!=0||allAction[o+2]!=0||delta==0||delta==sbyte.MinValue)throw new NotSupportedException("Official movement records require zero flags and a signed1..127 delta.");
                    kind=(byte)(0x40+(mapped-0xF5)*16);key=allAction[o+3];
                }
                else throw new NotSupportedException("Unsupported official macro key class.");
                result.Add((byte)(kind|(allAction[o+1]&0x80)|(delay>>8)));result.Add((byte)delay);result.Add(key);
            }
            if(result.Count>375)throw new ArgumentException("Action stream exceeds15-fragment protocol capacity.");return result.ToArray();
        }
        // Editor helper: one official key record per action, plus an optional following03 delay.
        // virtualKeys use the exact official table. Release bits and delay units are explicit.
        public static In9StoredMacro BuildStoredMacro(byte[] virtualKeys,bool[] releases,int[] delaysAfterMilliseconds)
        {
            if(virtualKeys==null||releases==null||delaysAfterMilliseconds==null||virtualKeys.Length!=releases.Length||virtualKeys.Length!=delaysAfterMilliseconds.Length||virtualKeys.Length>125)throw new ArgumentException("Matching action arrays of at most125 entries required.");
            var b=new byte[1344];int n=0;
            for(int i=0;i<virtualKeys.Length;i++){
                int delay=delaysAfterMilliseconds[i];if(delay<0||delay>4095||virtualKeys[i]==3||OfficialKeyTranslation[virtualKeys[i]]==0)throw new ArgumentException("Unsupported key or delay.");
                if(n>=336)throw new ArgumentException("Stored record capacity exceeded.");b[n*4]=virtualKeys[i];b[n*4+1]=(byte)(releases[i]?128:0);n++;
                if(delay>0){if(n>=336)throw new ArgumentException("Stored record capacity exceeded.");b[n*4]=3;b[n*4+1]=(byte)(delay>>16);b[n*4+2]=(byte)(delay>>8);b[n*4+3]=(byte)delay;n++;}
            }
            // Also verifies that every action class is represented by this codec.
            StoredMacroToActionStream(b,n);return new In9StoredMacro{RecordCount=n,AllAction=b};
        }
        // Hub keyboard codes are HID usages, whereas PSF stores the original executable's
        // virtual-key table indices. Reverse only proven entries; never substitute key codes.
        public static In9StoredMacro BuildStoredMacroFromHubEvents(In9HubMacroEvent[] events)
        {
            if(events==null || events.Length==0 || events.Length>4096)throw new ArgumentException("A nonempty Hub macro of at most4096 events is required.");
            var actions=new List<byte[]>();var delays=new List<int>();var held=new HashSet<string>(StringComparer.Ordinal);
            foreach(var e in events){
                if(e==null)throw new ArgumentException("Macro event cannot be null.");
                if(e.Kind=="delay"){
                    if(e.Unit!="milliseconds" || e.Duration<0 || e.Duration>4095 || delays.Count==0)throw new NotSupportedException("Only following millisecond delays of0..4095 are supported; leading delays and device ticks cannot be uploaded losslessly.");
                    int last=delays.Count-1;int sum=checked(delays[last]+e.Duration);if(sum>4095)throw new NotSupportedException("Combined delay exceeds12-bit wire capacity.");delays[last]=sum;continue;
                }
                if(e.Kind=="move"){
                    if(e.X < -127 || e.X > 127 || e.Y < -127 || e.Y > 127)throw new NotSupportedException("Official cursor movement requires each axis within -127..127.");
                    if(e.X==0&&e.Y==0)throw new NotSupportedException("A zero-vector movement event has no official action and cannot be uploaded.");
                    int required=(e.X==0?0:1)+(e.Y==0?0:1);if(actions.Count+required>125)throw new ArgumentException("Macro exceeds125 encoded actions /15 transport fragments after expanding cursor movement.");
                    if(e.X!=0)AddMovement(actions,delays,0xE5,e.X);
                    if(e.Y!=0)AddMovement(actions,delays,0xE6,e.Y);
                    continue;
                }
                bool release=e.Kind=="keyUp" || e.Kind=="mouseUp";byte vk=0;string token;
                if(e.Kind=="keyDown" || e.Kind=="keyUp"){
                    if(e.Code<1 || e.Code>255 || (e.Code>0x90 && (e.Code<0xE0 || e.Code>0xE7)))throw new NotSupportedException("Keyboard HID usage is outside the proven macro classes.");
                    for(int i=0;i<OfficialKeyTranslation.Length;i++)if(OfficialKeyTranslation[i]==e.Code){vk=(byte)i;break;}
                    if(vk==0)throw new NotSupportedException("Keyboard HID usage has no official macro translation: "+e.Code.ToString(CultureInfo.InvariantCulture));
                    token="key:"+e.Code.ToString(CultureInfo.InvariantCulture);
                }else if(e.Kind=="mouseDown" || e.Kind=="mouseUp"){
                    int button=Array.IndexOf(new[]{"left","right","middle","back","forward"},e.Button);
                    if(button<0)throw new NotSupportedException("Unsupported mouse macro button.");
                    int translated=0xF0+button;for(int i=0;i<OfficialKeyTranslation.Length;i++)if(OfficialKeyTranslation[i]==translated){vk=(byte)i;break;}
                    if(vk==0)throw new NotSupportedException("Mouse button has no official macro translation.");token="mouse:"+e.Button;
                }else throw new NotSupportedException("Macro event kind cannot be uploaded losslessly: "+e.Kind);
                if(release){if(!held.Remove(token))throw new ArgumentException("Macro contains an unpaired release: "+token);}else if(!held.Add(token))throw new ArgumentException("Macro contains a duplicate press: "+token);
                if(actions.Count>=125)throw new ArgumentException("Macro exceeds125 encoded actions /15 transport fragments.");
                actions.Add(new[]{vk,(byte)(release?128:0),(byte)0,(byte)0});delays.Add(0);
            }
            if(held.Count!=0)throw new ArgumentException("Macro contains keys or mouse buttons without releases.");
            if(actions.Count==0)throw new ArgumentException("Macro contains no uploadable actions.");
            var allAction=new byte[1344];int record=0;
            for(int i=0;i<actions.Count;i++){
                if(record>=336)throw new ArgumentException("Stored macro record capacity exceeded.");
                Buffer.BlockCopy(actions[i],0,allAction,record*4,4);record++;
                if(delays[i]>0){if(record>=336)throw new ArgumentException("Stored macro record capacity exceeded.");allAction[record*4]=3;allAction[record*4+1]=(byte)(delays[i]>>16);allAction[record*4+2]=(byte)(delays[i]>>8);allAction[record*4+3]=(byte)delays[i];record++;}
            }
            StoredMacroToActionStream(allAction,record);
            return new In9StoredMacro{RecordCount=record,AllAction=allAction};
        }
        private static void AddMovement(List<byte[]> actions,List<int> delays,byte officialVk,int signedMagnitude)
        {
            var record=new byte[4];record[0]=officialVk;record[3]=unchecked((byte)signedMagnitude);actions.Add(record);delays.Add(0);
        }
        public static string Hex(byte[] bytes){return BitConverter.ToString(bytes).Replace("-","");}
        public static byte[] Unhex(string text)
        {
            if(text==null || text.Length%2!=0)throw new FormatException("Expected an even number of hex digits.");var b=new byte[text.Length/2];
            for(int i=0;i<b.Length;i++)b[i]=byte.Parse(text.Substring(i*2,2),NumberStyles.HexNumber,CultureInfo.InvariantCulture);return b;
        }
    }
}
