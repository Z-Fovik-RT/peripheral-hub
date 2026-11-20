using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace PeripheralHub
{
    public sealed class WindowsForegroundSample
    {
        public int ProcessId { get; private set; }
        public string FilePath { get; private set; }
        internal WindowsForegroundSample(int processId, string filePath) { ProcessId = processId; FilePath = filePath; }
    }

    public sealed class WindowsForegroundObserver : IDisposable
    {
        private const uint EventSystemForeground = 0x0003, WmQuit = 0x0012;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const int MaximumPathCharacters = 2048, MaximumQueuedEvents = 256;
        private readonly object gate = new object();
        private readonly Queue<WindowsForegroundSample> events = new Queue<WindowsForegroundSample>();
        private readonly ManualResetEventSlim started = new ManualResetEventSlim(false);
        private readonly Thread thread;
        private readonly WinEventDelegate callback;
        private uint threadId;
        private IntPtr hook;
        private bool accepting, disposed;
        private Exception startupError, cleanupError;
        private string callbackError;

        public WindowsForegroundObserver()
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) throw new PlatformNotSupportedException("Foreground observation requires Windows.");
            callback = OnForeground;
            thread = new Thread(RunMessageLoop) { IsBackground = true, Name = "PeripheralHub.WindowsForeground" };
            thread.Start();
            if (!started.Wait(5000))
            {
                Stop();
                throw new TimeoutException("Windows foreground listener did not initialize within 5 seconds.");
            }
            if (startupError != null)
            {
                Stop();
                throw new InvalidOperationException("Windows foreground listener initialization failed.", startupError);
            }
        }

        public static Task<string> ReadCommandAsync() { return Task.Run(() => Console.In.ReadLine()); }

        public static WindowsForegroundSample ReadCurrent()
        {
            return ReadWindow(GetForegroundWindow());
        }

        private static WindowsForegroundSample ReadWindow(IntPtr window)
        {
            if (window == IntPtr.Zero) return new WindowsForegroundSample(0, null);
            uint processId;
            if (GetWindowThreadProcessId(window, out processId) == 0 || processId == 0 || processId > Int32.MaxValue)
                return new WindowsForegroundSample(0, null);
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (process == IntPtr.Zero) return new WindowsForegroundSample((int)processId, null);
            try
            {
                uint length = MaximumPathCharacters + 1;
                var path = new StringBuilder((int)length);
                if (!QueryFullProcessImageName(process, 0, path, ref length) || length == 0 || length > MaximumPathCharacters)
                    return new WindowsForegroundSample((int)processId, null);
                string value = path.ToString();
                if (value.Length != length || !IsFullPath(value)) return new WindowsForegroundSample((int)processId, null);
                return new WindowsForegroundSample((int)processId, value);
            }
            finally { CloseHandle(process); }
        }

        private static bool IsFullPath(string path)
        {
            if (String.IsNullOrEmpty(path) || path.Length > MaximumPathCharacters || !System.IO.Path.IsPathFullyQualified(path)) return false;
            foreach (char value in path) if (value < 32) return false;
            return true;
        }

        private void OnForeground(IntPtr eventHook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime)
        {
            if (eventType != EventSystemForeground) return;
            lock (gate) { if (!accepting) return; }
            try
            {
                // Queued WinEvents can be stale after a rapid focus change. Never replace a newer foreground with one.
                if (window != GetForegroundWindow()) return;
                WindowsForegroundSample sample = ReadWindow(window);
                lock (gate)
                {
                    if (!accepting) return;
                    if (events.Count >= MaximumQueuedEvents) throw new InvalidOperationException("Windows foreground event queue exceeded its fixed limit.");
                    events.Enqueue(sample);
                }
            }
            catch (Exception error)
            {
                lock (gate) { if (callbackError == null) callbackError = error.Message; }
            }
        }

        private void RunMessageLoop()
        {
            bool initialized = false;
            try
            {
                threadId = GetCurrentThreadId();
                Message message;
                // Create the thread queue before Start returns so Stop can always post WM_QUIT.
                PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
                hook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero, callback, 0, 0, 0);
                if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot install Windows foreground event hook.");
                lock (gate) accepting = true;
                initialized = true;
                started.Set();
                int status;
                while ((status = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
                if (status < 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows foreground message loop failed.");
            }
            catch (Exception error)
            {
                if (!initialized) startupError = error;
                else lock (gate) { if (callbackError == null) callbackError = error.Message; }
            }
            finally
            {
                lock (gate) accepting = false;
                if (hook != IntPtr.Zero)
                {
                    if (!UnhookWinEvent(hook)) cleanupError = new Win32Exception(Marshal.GetLastWin32Error(), "Cannot remove Windows foreground event hook.");
                    hook = IntPtr.Zero;
                }
                started.Set();
                GC.KeepAlive(callback);
            }
        }

        public WindowsForegroundSample Dequeue()
        {
            lock (gate) { return events.Count == 0 ? null : events.Dequeue(); }
        }

        public string TakeError()
        {
            lock (gate) { string value = callbackError; callbackError = null; return value; }
        }

        public void Stop()
        {
            if (Thread.CurrentThread == thread) throw new InvalidOperationException("Windows foreground listener cannot join its own callback thread.");
            lock (gate) accepting = false;
            if (thread.IsAlive)
            {
                if (threadId == 0 || !PostThreadMessage(threadId, WmQuit, UIntPtr.Zero, IntPtr.Zero))
                {
                    if (thread.IsAlive) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot stop Windows foreground message loop.");
                }
                if (!thread.Join(5000)) throw new TimeoutException("Windows foreground callback thread did not stop within 5 seconds.");
            }
            if (cleanupError != null) throw new InvalidOperationException("Windows foreground hook cleanup failed.", cleanupError);
            GC.KeepAlive(callback);
        }

        public void Dispose()
        {
            if (disposed) return;
            Stop();
            disposed = true;
            started.Dispose();
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Position; public uint Private; }
        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint eventThread, uint eventTime);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", EntryPoint = "PeekMessageW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint remove);
        [DllImport("user32.dll", EntryPoint = "GetMessageW", SetLastError = true)]
        private static extern int GetMessage(out Message message, IntPtr window, uint first, uint last);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll", EntryPoint = "DispatchMessageW")]
        private static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("user32.dll", EntryPoint = "PostThreadMessageW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    }
}
