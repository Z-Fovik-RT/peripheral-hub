using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace PeripheralHub
{
    // Windows user preferences, shared by all mice. Never opens a HID device or emits input.
    public static class SystemMouse
    {
        public sealed class Snapshot
        {
            public int PointerSpeed { get; set; }
            public int WheelLines { get; set; }
            public int HorizontalCharacters { get; set; }
            public int DoubleClickMs { get; set; }
            public bool EnhancedPrecision { get; set; }
            public bool SwapPrimary { get; set; }
            public int MouseThreshold1 { get; set; }
            public int MouseThreshold2 { get; set; }
            public int MouseAccelerationRaw { get; set; }
        }

        public static Snapshot Read()
        {
            int speed=0,lines=0,characters=0;var mouse=new int[3];
            Check(SystemParametersInfo(0x70,0,ref speed,0),"Read pointer speed");
            Check(SystemParametersInfo(0x68,0,ref lines,0),"Read vertical wheel lines");
            Check(SystemParametersInfo(0x6C,0,ref characters,0),"Read horizontal wheel characters");
            Check(SystemParametersInfoArray(0x03,0,mouse,0),"Read mouse threshold/acceleration tuple");
            bool swap=GetSystemMetrics(23)!=0;
            return new Snapshot {
                PointerSpeed=speed,WheelLines=lines,HorizontalCharacters=characters,
                DoubleClickMs=checked((int)GetDoubleClickTime()),EnhancedPrecision=mouse[2]!=0,
                SwapPrimary=swap,MouseThreshold1=mouse[0],MouseThreshold2=mouse[1],MouseAccelerationRaw=mouse[2]
            };
        }

        public static void Validate(string setting,int value)
        {
            switch(setting){
                case "pointerSpeed": if(value<1||value>20)throw new ArgumentOutOfRangeException(nameof(value));break;
                case "wheelLines": if(value != -1 && (value<0||value>100))throw new ArgumentOutOfRangeException(nameof(value));break;
                case "horizontalCharacters": if(value<0||value>100)throw new ArgumentOutOfRangeException(nameof(value));break;
                case "doubleClickMs": if(value<1||value>5000)throw new ArgumentOutOfRangeException(nameof(value));break;
                case "enhancedPrecision": if(value!=0&&value!=1)throw new ArgumentOutOfRangeException(nameof(value));break;
                case "swapPrimary": if(value!=0&&value!=1)throw new ArgumentOutOfRangeException(nameof(value));break;
                default: throw new ArgumentException("Unknown Windows mouse preference.",nameof(setting));
            }
        }

        public static Snapshot Set(string setting,int value)
        {
            Validate(setting,value);var before=Read();ValidateSnapshot(before);
            try {
                Write(setting,value);var after=Read();
                if(Value(after,setting)!=value)throw new InvalidOperationException("Windows mouse preference readback differs from request.");
                return after;
            }
            catch(Exception error){
                try { WriteSnapshot(before);if(!Same(Read(),before))throw new InvalidOperationException("Full mouse recovery snapshot mismatch."); }
                catch(Exception recovery){throw new AggregateException("Mouse preference apply and full recovery failed; retain the complete saved snapshot.",error,recovery);}
                throw new InvalidOperationException("Mouse preference apply failed; its complete previous state was restored.",error);
            }
        }

        public static int Value(Snapshot s,string setting)
        {
            switch(setting){
                case "pointerSpeed":return s.PointerSpeed;
                case "wheelLines":return s.WheelLines;
                case "horizontalCharacters":return s.HorizontalCharacters;
                case "doubleClickMs":return s.DoubleClickMs;
                case "enhancedPrecision":return s.EnhancedPrecision?1:0;
                case "swapPrimary":return s.SwapPrimary?1:0;
                default:throw new ArgumentException("Unknown preference.");
            }
        }

        public static Snapshot Restore(Snapshot baseline)
        {
            if(baseline==null)throw new ArgumentNullException(nameof(baseline));
            ValidateSnapshot(baseline);var before=Read();ValidateSnapshot(before);
            try {
                WriteSnapshot(baseline);var after=Read();
                if(!Same(after,baseline))throw new InvalidOperationException("Full Windows mouse snapshot restore readback mismatch.");
                return after;
            }catch(Exception failure){
                try {WriteSnapshot(before);if(!Same(Read(),before))throw new InvalidOperationException("Immediate full-state recovery readback mismatch.");}
                catch(Exception recovery){throw new AggregateException("Snapshot restore failed and immediate state recovery also failed; keep the saved baseline.",failure,recovery);}
                throw new InvalidOperationException("Snapshot restore failed; the immediate previous state was restored and verified.",failure);
            }
        }

        public static void RestoreSetting(Snapshot baseline,string setting)
        {
            ValidateSnapshot(baseline);var before=Read();ValidateSnapshot(before);
            try {
                WriteSnapshotSetting(baseline,setting);
                if(!SameSetting(Read(),baseline,setting))throw new InvalidOperationException("Windows mouse setting restore readback mismatch: "+setting);
            }catch(Exception failure){
                try {WriteSnapshot(before);if(!Same(Read(),before))throw new InvalidOperationException("Immediate full-state recovery readback mismatch.");}
                catch(Exception recovery){throw new AggregateException("Setting restore failed and immediate state recovery also failed; keep the saved baseline.",failure,recovery);}
                throw new InvalidOperationException("Setting restore failed; the immediate previous state was restored and verified.",failure);
            }
        }

        public static bool SameSetting(Snapshot a,Snapshot b,string setting)
        {
            if(a==null||b==null) return false;
            switch(setting){
                case "pointerSpeed":return a.PointerSpeed==b.PointerSpeed;
                case "wheelLines":return a.WheelLines==b.WheelLines;
                case "horizontalCharacters":return a.HorizontalCharacters==b.HorizontalCharacters;
                case "doubleClickMs":return a.DoubleClickMs==b.DoubleClickMs;
                case "mouseAcceleration":return a.MouseThreshold1==b.MouseThreshold1&&a.MouseThreshold2==b.MouseThreshold2&&a.MouseAccelerationRaw==b.MouseAccelerationRaw;
                case "swapPrimary":return a.SwapPrimary==b.SwapPrimary;
                default:throw new ArgumentException("Unknown preference.",nameof(setting));
            }
        }

        public static bool Same(Snapshot a,Snapshot b)
        {
            return a!=null&&b!=null&&a.PointerSpeed==b.PointerSpeed&&a.WheelLines==b.WheelLines&&
                a.HorizontalCharacters==b.HorizontalCharacters&&a.DoubleClickMs==b.DoubleClickMs&&
                a.SwapPrimary==b.SwapPrimary&&a.MouseThreshold1==b.MouseThreshold1&&
                a.MouseThreshold2==b.MouseThreshold2&&a.MouseAccelerationRaw==b.MouseAccelerationRaw;
        }

        public static void ValidateSnapshot(Snapshot s)
        {
            if(s==null)throw new ArgumentNullException(nameof(s));
            Validate("pointerSpeed",s.PointerSpeed);Validate("wheelLines",s.WheelLines);
            Validate("horizontalCharacters",s.HorizontalCharacters);Validate("doubleClickMs",s.DoubleClickMs);
            if(s.MouseThreshold1<0||s.MouseThreshold2<0||s.MouseAccelerationRaw<0||s.MouseAccelerationRaw>2)
                throw new ArgumentOutOfRangeException(nameof(s),"Invalid SPI_GETMOUSE tuple.");
            if(s.EnhancedPrecision!=(s.MouseAccelerationRaw!=0))throw new ArgumentException("Enhanced-precision flag disagrees with the saved SPI_GETMOUSE tuple.",nameof(s));
        }

        private static void WriteSnapshot(Snapshot s)
        {
            ValidateSnapshot(s);
            foreach(string setting in new[]{"pointerSpeed","wheelLines","horizontalCharacters","mouseAcceleration","swapPrimary","doubleClickMs"})WriteSnapshotSetting(s,setting);
        }

        private static void WriteSnapshotSetting(Snapshot s,string setting)
        {
            switch(setting){
                case "pointerSpeed": Check(SystemParametersInfoValue(0x71,0,new IntPtr(s.PointerSpeed),3),"Restore pointer speed");break;
                case "wheelLines": Check(SystemParametersInfoValue(0x69,unchecked((uint)s.WheelLines),IntPtr.Zero,3),"Restore vertical wheel lines");break;
                case "horizontalCharacters": Check(SystemParametersInfoValue(0x6D,unchecked((uint)s.HorizontalCharacters),IntPtr.Zero,3),"Restore horizontal wheel characters");break;
                case "mouseAcceleration": {int[] mouse={s.MouseThreshold1,s.MouseThreshold2,s.MouseAccelerationRaw};Check(SystemParametersInfoArray(0x04,0,mouse,3),"Restore SPI_SETMOUSE tuple");break;}
                case "swapPrimary": Check(SystemParametersInfoValue(0x21,s.SwapPrimary?1u:0u,IntPtr.Zero,3),"Restore primary-button swap");break;
                case "doubleClickMs": Check(SystemParametersInfoValue(0x20,unchecked((uint)s.DoubleClickMs),IntPtr.Zero,3),"Restore double-click interval");break;
                default:throw new ArgumentException("Unknown preference.",nameof(setting));
            }
        }

        private static void Write(string setting,int value)
        {
            switch(setting){
                case "pointerSpeed": Check(SystemParametersInfoValue(0x71,0,new IntPtr(value),3),"Set pointer speed");break;
                case "wheelLines": Check(SystemParametersInfoValue(0x69,unchecked((uint)value),IntPtr.Zero,3),"Set vertical wheel lines");break;
                case "horizontalCharacters": Check(SystemParametersInfoValue(0x6D,unchecked((uint)value),IntPtr.Zero,3),"Set horizontal wheel characters");break;
                case "doubleClickMs": Check(SystemParametersInfoValue(0x20,unchecked((uint)value),IntPtr.Zero,3),"Set double-click interval");break;
                case "enhancedPrecision": {
                    var mouse=new int[3];Check(SystemParametersInfoArray(0x03,0,mouse,0),"Read SPI_GETMOUSE before changing precision");
                    if(value==0)mouse[2]=0;else if(mouse[2]==0)mouse[2]=1;
                    Check(SystemParametersInfoArray(0x04,0,mouse,3),"Set pointer precision");break;
                }
                case "swapPrimary": Check(SystemParametersInfoValue(0x21,(uint)value,IntPtr.Zero,3),"Set primary-button swap");break;
                default: throw new ArgumentException("Unknown preference.",nameof(setting));
            }
        }

        private static void Check(bool success,string operation){if(!success)throw new Win32Exception(Marshal.GetLastWin32Error(),operation);}
        [DllImport("user32.dll",EntryPoint="SystemParametersInfoW",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
        private static extern bool SystemParametersInfo(uint action,uint parameter,ref int value,uint flags);
        [DllImport("user32.dll",EntryPoint="SystemParametersInfoW",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
        private static extern bool SystemParametersInfoArray(uint action,uint parameter,[In,Out]int[] value,uint flags);
        [DllImport("user32.dll",EntryPoint="SystemParametersInfoW",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
        private static extern bool SystemParametersInfoValue(uint action,uint parameter,IntPtr value,uint flags);
        [DllImport("user32.dll")] private static extern uint GetDoubleClickTime();
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    }
}
