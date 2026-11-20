using System;
using System.Collections.Generic;
using System.Text;

namespace PeripheralHub
{
    /// <summary>
    /// Offline parsers for the installed G5KB code path (RVA0x89C50,0x8A310,0x8A6B0).
    /// Does not open a HID device, record input, or write hardware.
    /// Matrix/macro semantics are static evidence until checked against a device snapshot.
    /// </summary>
    public static class AulaConfigurationCodec
    {
        public sealed class MatrixEntry
        {
            public int Index {get; internal set;}
            public int Offset {get; internal set;}
            public uint RawValue {get; internal set;}
            public byte[] Raw {get; internal set;}
            public string Kind {get; internal set;}
            public int? Modifiers {get; internal set;}
            public int? PrimaryHidUsage {get; internal set;}
            public int? SecondaryHidUsage {get; internal set;}
            public int? ConsumerUsage {get; internal set;}
            public int? MacroMode {get; internal set;}
            public int? MacroRepeatCount {get; internal set;}
            public int? MacroIndex {get; internal set;}
        }
        public sealed class MatrixSnapshot
        {
            public int Layer {get; internal set;}
            public byte[] Raw {get; internal set;}
            public bool HasCrcMarker {get; internal set;}
            public MatrixEntry[] Entries {get; internal set;}
            public string Evidence {get; internal set;}
        }
        public sealed class RgbColor
        {
            public int R {get; internal set;}
            public int G {get; internal set;}
            public int B {get; internal set;}
            public string Hex {get; internal set;}
        }
        public sealed class PaletteGroup
        {
            public int ModeTableIndex {get; internal set;}
            public int Offset {get; internal set;}
            public RgbColor[] Colors {get; internal set;}
        }
        public sealed class PaletteSnapshot
        {
            public byte[] Raw {get; internal set;}
            public PaletteGroup[] Groups {get; internal set;}
            public string Evidence {get; internal set;}
        }
        public sealed class MacroEvent
        {
            public byte[] Raw {get; internal set;}
            public int EventClass {get; internal set;}
            public int DelayTicks {get; internal set;}
            public int Code {get; internal set;}
            public bool Flag80 {get; internal set;}
        }
        public sealed class MacroRecord
        {
            public int Index {get; internal set;}
            public int Offset {get; internal set;}
            public int Length {get; internal set;}
            public string Name {get; internal set;}
            public byte[] Raw {get; internal set;}
            public MacroEvent[] Events {get; internal set;}
        }
        public static MatrixSnapshot ParseMatrix512(byte[] data, int layer, bool requireMarker)
        {
            RequireLength(data,512);
            if(layer<0 || layer>3)throw new ArgumentOutOfRangeException(nameof(layer));
            bool marker=data[508]==0 && data[509]==0 && data[510]==0x5A && data[511]==0xA5;
            if(requireMarker && !marker)throw new ArgumentException("Matrix CRC marker00005AA5 is missing.",nameof(data));
            var entries=new List<MatrixEntry>();
            for(int i=0;i<128;i++)
            {
                int o=i*4;byte a=data[o],b=data[o+1],c=data[o+2],d=data[o+3];
                var entry=new MatrixEntry {
                    Index=i,Offset=o,RawValue=(uint)(a|(b<<8)|(c<<16)|(d<<24)),Raw=new[]{a,b,c,d},Kind="unknown"
                };
                if(i==127 && marker)entry.Kind="crc-marker";
                else if(a==0){entry.Kind=b==0&&c==0&&d==0?"empty-or-disabled":"keyboard";entry.Modifiers=b;entry.SecondaryHidUsage=c;entry.PrimaryHidUsage=d;}
                else if(a==1)entry.Kind="mouse-action";
                else if(a==2){entry.Kind="consumer";entry.ConsumerUsage=(c<<8)|d;}
                else if(a==3){entry.Kind="macro";entry.MacroMode=b;entry.MacroRepeatCount=c;entry.MacroIndex=d;}
                else if(a==5)entry.Kind="layer-or-special";
                else if(a==7)entry.Kind="firmware-action";
                else if(a==0x0D)entry.Kind="fn-special";
                entries.Add(entry);
            }
            return new MatrixSnapshot {Layer=layer,Raw=(byte[])data.Clone(),HasCrcMarker=marker,Entries=entries.ToArray(),
                Evidence="Static G5KB key codec RVA0x89C50; matrix4-byte records and CRC from0x8A6B0; layer0..3,512bytes per installed MatrixLen128. Semantics require snapshot validation."};
        }
        public static PaletteSnapshot ParsePalette512(byte[] data)
        {
            RequireLength(data,512);
            // The signature is four bytes before the end, as seen in the original cmd09 trace.
            if(data[506]!=0x5A || data[507]!=0xA5)throw new ArgumentException("RGB palette marker at506/507 is missing.",nameof(data));
            var groups=new List<PaletteGroup>();
            // Seven RGB triples,21bytes/mode. Group0 is reserved; the installed profile defines20 modes.
            for(int mode=0;mode<20;mode++)
            {
                int offset=21*(mode+1);var colors=new RgbColor[7];
                for(int color=0;color<7;color++)
                {
                    int o=offset+color*3;
                    colors[color]=new RgbColor {R=data[o],G=data[o+1],B=data[o+2],Hex="#"+data[o].ToString("X2")+data[o+1].ToString("X2")+data[o+2].ToString("X2")};
                }
                groups.Add(new PaletteGroup {ModeTableIndex=mode,Offset=offset,Colors=colors});
            }
            return new PaletteSnapshot {Raw=(byte[])data.Clone(),Groups=groups.ToArray(),Evidence="RVA0x8B529..0x8B795; RGBIndex=0,1,2; original cmd09 transmitted512bytes with signature506/507. A readback snapshot is still required."};
        }
        public static MacroRecord[] ParseMacroTable(byte[] data, int count)
        {
            if(data==null)throw new ArgumentNullException(nameof(data));
            if(count<0 || count>100 || count*4>data.Length)throw new ArgumentOutOfRangeException(nameof(count));
            int tableBytes=count*4;var result=new MacroRecord[count];int previousEnd=tableBytes;
            for(int i=0;i<count;i++)
            {
                int offset=Read16(data,i*4),length=Read16(data,i*4+2);
                if(offset<tableBytes || offset<previousEnd || length<1 || offset>data.Length-length)
                    throw new ArgumentException("Invalid or overlapping macro directory entry at"+i,nameof(data));
                byte[] record=new byte[length];Buffer.BlockCopy(data,offset,record,0,length);
                var parsed=ParseMacroRecord(record);parsed.Index=i;parsed.Offset=offset;result[i]=parsed;
                previousEnd=offset+length;
            }
            return result;
        }
        public static MacroRecord ParseMacroRecord(byte[] record)
        {
            if(record==null || record.Length<1)throw new ArgumentException("Macro record is empty.",nameof(record));
            int nameBytes=record[0];
            if(nameBytes>60 || (nameBytes&1)!=0 || 1+nameBytes>record.Length || ((record.Length-1-nameBytes)&3)!=0)
                throw new ArgumentException("Invalid macro name/event alignment.",nameof(record));
            var events=new List<MacroEvent>();
            for(int o=1+nameBytes;o<record.Length;o+=4)
            {
                byte a=record[o],b=record[o+1],c=record[o+2],d=record[o+3];
                events.Add(new MacroEvent {Raw=new[]{a,b,c,d},EventClass=(a>>4)&7,Flag80=(a&0x80)!=0,DelayTicks=((a&15)<<16)|(b<<8)|c,Code=d});
            }
            return new MacroRecord {Index=-1,Offset=0,Length=record.Length,Name=new UnicodeEncoding(false,false,true).GetString(record,1,nameBytes),Raw=(byte[])record.Clone(),Events=events.ToArray()};
        }
        // Pure encoding primitives for offline fixtures, not a device write API.
        public static byte[] EncodeKeyboardEntry(byte modifiers, byte primaryUsage, byte secondaryUsage)
        {return new[]{(byte)0,modifiers,secondaryUsage,primaryUsage};}
        public static byte[] EncodeConsumerEntry(ushort usage)
        {return new[]{(byte)2,(byte)0,(byte)(usage>>8),(byte)usage};}
        public static byte[] EncodeMacroEvent(int eventClass, bool flag80, int delayTicks, byte code)
        {
            if(eventClass<0 || eventClass>5)throw new ArgumentOutOfRangeException(nameof(eventClass));
            if(delayTicks<0 || delayTicks>0xFFFFF)throw new ArgumentOutOfRangeException(nameof(delayTicks));
            return new[]{(byte)((eventClass<<4)|(flag80?0x80:0)|((delayTicks>>16)&15)),(byte)(delayTicks>>8),(byte)delayTicks,code};
        }
        private static int Read16(byte[] b,int o){return b[o]|(b[o+1]<<8);}
        private static void RequireLength(byte[] data,int length)
        {if(data==null || data.Length!=length)throw new ArgumentException("Expected exact"+length+"-byte configuration block.",nameof(data));}
    }
}
