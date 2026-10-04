using System;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace AgentComms.Windows {
    // Experimental primitive only: no service, credentials, TCP or global ACL changes.
    public static class PrivatePipe {
        const uint Duplex = 3, Overlapped = 0x40000000, FirstInstance = 0x00080000;
        const uint RejectRemote = 8;
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes {
            public int Length;
            public IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern uint GetSecurityInfo(SafePipeHandle handle, int objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

        public static string UserSid { get { return WindowsIdentity.GetCurrent().User.Value; } }
        public static string Name(string suffix) {
            if (String.IsNullOrEmpty(suffix) || suffix.Length > 64) throw new ArgumentException("Invalid pipe suffix");
            foreach(char c in suffix) if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-') throw new ArgumentException("Invalid pipe suffix");
            return "agent-comms-" + UserSid + "-" + suffix;
        }
        public static string Descriptor(NamedPipeServerStream pipe) {
            IntPtr owner, group, dacl, sacl, descriptor;
            uint error = GetSecurityInfo(pipe.SafePipeHandle, 6, 1|4, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error);
            try {
                byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
                Marshal.Copy(descriptor, bytes, 0, bytes.Length);
                return new RawSecurityDescriptor(bytes, 0).GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
            } finally { LocalFree(descriptor); }
        }
        public static NamedPipeServerStream Create(string suffix, bool first = true) {
            string sid = UserSid;
            // Only the current Windows user. Administrators can take ownership,
            // but have no explicit access grant. Descriptor applies atomically.
            string sddl = "O:" + sid + "D:P(A;;GA;;;" + sid + ")";
            IntPtr descriptor; uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = false };
                var handle = CreateNamedPipe(@"\\.\pipe\" + Name(suffix), Duplex | Overlapped | (first ? FirstInstance : 0), RejectRemote, 64, 65536, 65536, 0, ref attributes);
                if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
                try {
                    var pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
                    // Fail closed before accepting a client if the descriptor differs.
                    var actual = new RawSecurityDescriptor(Descriptor(pipe));
                    if (actual.Owner.Value != sid || (actual.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || actual.DiscretionaryAcl == null || actual.DiscretionaryAcl.Count != 1) {
                        pipe.Dispose(); throw new InvalidOperationException("Unexpected named pipe security descriptor");
                    }
                    var ace = actual.DiscretionaryAcl[0] as CommonAce;
                    if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed || ace.SecurityIdentifier.Value != sid || ace.AccessMask != 0x001f01ff) {
                        pipe.Dispose(); throw new InvalidOperationException("Unexpected named pipe access rule");
                    }
                    return pipe;
                } catch { handle.Dispose(); throw; }
            } finally { LocalFree(descriptor); }
        }
    }
}
