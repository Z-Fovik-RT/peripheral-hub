using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PeripheralHub {
    public sealed class HidInterface {
        public string Path { get; set; }
        public string InstanceId { get; set; }
        public string ContainerId { get; set; }
        public string VendorId { get; set; }
        public string ProductId { get; set; }
        public string Manufacturer { get; set; }
        public string Product { get; set; }
        public string UsagePage { get; set; }
        public string Usage { get; set; }
        public string Kind { get; set; }
        public int InputReportBytes { get; set; }
        public int OutputReportBytes { get; set; }
        public int FeatureReportBytes { get; set; }
        public bool CapsRead { get; set; }
        public List<string> Notes { get; set; } = new List<string>();
    }
    public static class HidInventory {
        [StructLayout(LayoutKind.Sequential)]
        private struct InterfaceData { public uint cbSize; public Guid guid; public uint flags; public UIntPtr reserved; }
        [StructLayout(LayoutKind.Sequential)]
        private struct DeviceInfoData { public uint cbSize; public Guid guid; public uint devInst; public UIntPtr reserved; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Attributes { public int Size; public ushort VendorID; public ushort ProductID; public ushort VersionNumber; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Caps {
            public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst=17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices;
            public ushort NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices;
            public ushort NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
        }
        [DllImport("hid.dll")] private static extern void HidD_GetHidGuid(out Guid guid);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr SetupDiGetClassDevsW(ref Guid guid, string enumerator, IntPtr parent, uint flags);
        [DllImport("setupapi.dll", SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid guid, uint index, ref InterfaceData data);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiGetDeviceInterfaceDetailW(IntPtr set, ref InterfaceData data, IntPtr detail, uint size, out uint needed, ref DeviceInfoData info);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiGetDeviceInstanceIdW(IntPtr set, ref DeviceInfoData info, StringBuilder id, uint size, out uint needed);
        [StructLayout(LayoutKind.Sequential)]
        private struct PropertyKey { public Guid fmtid; public uint pid; }
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiGetDevicePropertyW(IntPtr set, ref DeviceInfoData info, ref PropertyKey key, out uint propertyType, byte[] data, uint dataSize, out uint needed, uint flags);
        [DllImport("setupapi.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetAttributes(SafeFileHandle handle, ref Attributes attr);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetManufacturerString(SafeFileHandle handle, byte[] buffer, int length);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetProductString(SafeFileHandle handle, byte[] buffer, int length);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr data);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_FreePreparsedData(IntPtr data);
        [DllImport("hid.dll")] private static extern int HidP_GetCaps(IntPtr data, out Caps caps);

        private static string Text(SafeFileHandle handle, bool product) {
            var bytes = new byte[512];
            bool ok = product ? HidD_GetProductString(handle, bytes, bytes.Length) : HidD_GetManufacturerString(handle, bytes, bytes.Length);
            return ok ? Encoding.Unicode.GetString(bytes).TrimEnd('\0') : null;
        }
        private static string Classify(ushort page, ushort usage) {
            if (page >= 0xFF00) return "Vendor-defined";
            if (page == 1 && usage == 2) return "Mouse";
            if (page == 1 && usage == 6) return "Keyboard";
            if (page == 0x0C) return "Consumer control";
            if (page == 0x0D) return "Digitizer";
            return "Other HID";
        }
        public static List<HidInterface> Scan() {
            var result = new List<HidInterface>();
            Guid guid; HidD_GetHidGuid(out guid);
            IntPtr set = SetupDiGetClassDevsW(ref guid, null, IntPtr.Zero, 0x12); // PRESENT | DEVICEINTERFACE
            if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                for (uint index = 0; ; index++) {
                    var data = new InterfaceData { cbSize = (uint)Marshal.SizeOf(typeof(InterfaceData)) };
                    if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, index, ref data)) {
                        int err = Marshal.GetLastWin32Error();
                        if (err == 259) break;
                        throw new Win32Exception(err);
                    }
                    var info = new DeviceInfoData { cbSize = (uint)Marshal.SizeOf(typeof(DeviceInfoData)) };
                    uint needed;
                    SetupDiGetDeviceInterfaceDetailW(set, ref data, IntPtr.Zero, 0, out needed, ref info);
                    if (needed < 8 || needed > 1048576) throw new InvalidOperationException("Invalid interface detail size.");
                    IntPtr buffer = Marshal.AllocHGlobal((int)needed);
                    try {
                        Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 8 : 6);
                        if (!SetupDiGetDeviceInterfaceDetailW(set, ref data, buffer, needed, out needed, ref info))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        var row = new HidInterface { Path = Marshal.PtrToStringUni(IntPtr.Add(buffer, 4)) };
                        var id = new StringBuilder(1024); uint idSize;
                        if (SetupDiGetDeviceInstanceIdW(set, ref info, id, (uint)id.Capacity, out idSize)) row.InstanceId = id.ToString();
                        var containerKey = new PropertyKey { fmtid = new Guid("8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C"), pid = 2 };
                        var containerBytes = new byte[16]; uint containerType, containerSize;
                        if (SetupDiGetDevicePropertyW(set, ref info, ref containerKey, out containerType, containerBytes, 16, out containerSize, 0)
                            && containerType == 13 && containerSize == 16)
                            row.ContainerId = new Guid(containerBytes).ToString("D");
                        // Access=0: metadata handle only. No input polling, output, feature commands or configuration changes.
                        using (var handle = CreateFileW(row.Path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                            if (handle.IsInvalid) {
                                row.Notes.Add("Metadata handle unavailable: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                            } else {
                                var attr = new Attributes { Size = Marshal.SizeOf(typeof(Attributes)) };
                                if (HidD_GetAttributes(handle, ref attr)) {
                                    row.VendorId = attr.VendorID.ToString("X4"); row.ProductId = attr.ProductID.ToString("X4");
                                }
                                row.Manufacturer = Text(handle, false); row.Product = Text(handle, true);
                                IntPtr parsed;
                                if (HidD_GetPreparsedData(handle, out parsed)) {
                                    try {
                                        Caps caps; int status = HidP_GetCaps(parsed, out caps);
                                        if (status == 0x00110000) {
                                            row.CapsRead = true;
                                            row.UsagePage = caps.UsagePage.ToString("X4"); row.Usage = caps.Usage.ToString("X4");
                                            row.Kind = Classify(caps.UsagePage, caps.Usage);
                                            row.InputReportBytes = caps.InputReportByteLength; row.OutputReportBytes = caps.OutputReportByteLength;
                                            row.FeatureReportBytes = caps.FeatureReportByteLength;
                                        } else row.Notes.Add("HidP_GetCaps status: 0x" + status.ToString("X8"));
                                    } finally { HidD_FreePreparsedData(parsed); }
                                } else row.Notes.Add("Preparsed metadata unavailable.");
                            }
                        }
                        result.Add(row);
                    } finally { Marshal.FreeHGlobal(buffer); }
                }
            } finally { SetupDiDestroyDeviceInfoList(set); }
            return result;
        }
    }
}
