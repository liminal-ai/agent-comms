using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
namespace AgentComms.Windows {
 public static class Bridge {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint rights, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static readonly object outputLock = new object();
  static readonly ConcurrentDictionary<int,PipeStream> streams = new ConcurrentDictionary<int,PipeStream>();
  static int sequence;
  static readonly ConcurrentDictionary<int,SemaphoreSlim> readAcks = new ConcurrentDictionary<int,SemaphoreSlim>();
  static void CheckPeer(PipeStream pipe, bool server) {
   uint pid; bool ok=server ? GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid) : GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid);
   if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
   IntPtr process=OpenProcess(0x1000,false,pid); if(process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
   IntPtr token=IntPtr.Zero;
   try { if(!OpenProcessToken(process,8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    using(var identity=new WindowsIdentity(token)) if(identity.User.Value!=PrivatePipe.UserSid) throw new UnauthorizedAccessException("Pipe peer is not the current user");
   } finally {if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
  }
  static void Emit(string operation,int id,string data="") {lock(outputLock){Console.Out.WriteLine(operation+"\t"+id+"\t"+data);Console.Out.Flush();}}
  static void Close(int id) {PipeStream pipe;if(streams.TryRemove(id,out pipe)){pipe.Dispose();SemaphoreSlim ack;if(readAcks.TryRemove(id,out ack)){try{ack.Release();}catch(SemaphoreFullException){}}Emit("C",id);}}
  static async Task Pump(PipeStream pipe,int id) {
   try { byte[] buffer=new byte[32768]; while(true){int n=await pipe.ReadAsync(buffer,0,buffer.Length);if(n==0)break;Emit("D",id,Convert.ToBase64String(buffer,0,n));SemaphoreSlim ack;if(readAcks.TryGetValue(id,out ack))await ack.WaitAsync();} }
   catch(IOException){} catch(ObjectDisposedException){} finally {Close(id);}
  }
  static async Task Input() {
   while(true){string line=await Console.In.ReadLineAsync();if(line==null)break;if(line.Length>50000)throw new InvalidDataException("Bridge frame too large");
    var parts=line.Split('\t');int id;if(parts.Length!=3||!Int32.TryParse(parts[1],out id))throw new InvalidDataException("Invalid bridge frame");
    PipeStream pipe;if(!streams.TryGetValue(id,out pipe))continue;
    if(parts[0]=="B"){SemaphoreSlim ack;if(readAcks.TryGetValue(id,out ack))ack.Release();continue;}
    if(parts[0]=="C"){Close(id);continue;}if(parts[0]!="D")throw new InvalidDataException("Invalid bridge operation");
    byte[] bytes=Convert.FromBase64String(parts[2]);if(bytes.Length>32768)throw new InvalidDataException("Bridge payload too large");
    // Writes are bounded; per-connection async queues are managed in the Node layer.
    _ = Write(pipe,id,bytes);
   }
  }
  static async Task Write(PipeStream pipe,int id,byte[] bytes){try{await pipe.WriteAsync(bytes,0,bytes.Length);Emit("A",id);}catch(IOException){Close(id);}catch(ObjectDisposedException){Close(id);}}
  public static async Task Run(string mode,string suffix) {
   NamedPipeServerStream listener=null;
   try {
    if(mode=="client") {
     var client=new NamedPipeClientStream(".",PrivatePipe.Name(suffix),PipeDirection.InOut,PipeOptions.Asynchronous);
     try {await client.ConnectAsync(250);CheckPeer(client,false);}catch{client.Dispose();throw;}
     streams[1]=client;readAcks[1]=new SemaphoreSlim(0,1);Emit("O",1);Task pump=Pump(client,1);await Task.WhenAny(Task.Run(Input),pump);return;
    }
    if(mode!="server")throw new ArgumentException("Invalid bridge mode");
    listener=PrivatePipe.Create(suffix,true);Emit("R",0);Task input=Task.Run(Input);
    while(!input.IsCompleted) {
     Task accept=listener.WaitForConnectionAsync();if(await Task.WhenAny(accept,input)==input)break;await accept;
     var connected=listener;listener=null;
     // Retain a handle while creating the replacement to keep namespace ownership.
     listener=PrivatePipe.Create(suffix,false);
     try {CheckPeer(connected,true);}catch{connected.Dispose();continue;}
     if(streams.Count>=60){connected.Dispose();continue;}
     int id=Interlocked.Increment(ref sequence);streams[id]=connected;readAcks[id]=new SemaphoreSlim(0,1);Emit("O",id);_ = Pump(connected,id);
    }
    await input;
   } finally {if(listener!=null)listener.Dispose();foreach(var id in streams.Keys)Close(id);}
  }
 }
}
