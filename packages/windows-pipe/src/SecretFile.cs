using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
namespace AgentComms.Windows {
 public static class SecretFile {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [StructLayout(LayoutKind.Sequential)] struct FileInformation { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInformation info);
  public static string Read(string path) {
   // Read + READ_CONTROL, share-read only: prevents replacement/writes while validating and reading this same handle.
   using(var handle=CreateFile(Path.GetFullPath(path),0x80020000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
    if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
    FileInformation info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.Attributes & (0x10u|0x400u))!=0)throw new UnauthorizedAccessException("Secret handle must be a plain file");
    IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(handle,1,1|4,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)throw new Win32Exception((int)error);
    try {
     byte[] bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);
     var security=new RawSecurityDescriptor(bytes,0);string sid=WindowsIdentity.GetCurrent().User.Value;
     if(security.Owner.Value!=sid||security.DiscretionaryAcl==null)throw new UnauthorizedAccessException("Secret must be owned by current user with an explicit DACL");
     foreach(GenericAce entry in security.DiscretionaryAcl){var ace=entry as CommonAce;if(ace==null)throw new UnauthorizedAccessException("Unsupported secret access rule");if(ace.AceQualifier==AceQualifier.AccessAllowed&&ace.SecurityIdentifier.Value!=sid)throw new UnauthorizedAccessException("Secret grants another principal access");}
    } finally {LocalFree(descriptor);}
    using(var stream=new FileStream(handle,FileAccess.Read)) {
     if(stream.Length>65536)throw new InvalidDataException("Secret file exceeds 64 KiB");
     using(var reader=new StreamReader(stream))return reader.ReadToEnd();
    }
   }
  }
 }
}
