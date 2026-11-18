param([Parameter(Mandatory=$true)][ValidateSet("pointer","click","scroll","key")][string]$Action,[double]$X=0,[double]$Y=0,[double]$DeltaX=0,[double]$DeltaY=0,[string]$Button="left",[string]$Key="")
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AdvisNativeInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, WHEEL=0x0800, KEYUP=0x0002, UNICODE=0x0004;
}
"@
switch ($Action) {
  "pointer" { [void][AdvisNativeInput]::SetCursorPos([int]$X,[int]$Y) }
  "click" {
    [void][AdvisNativeInput]::SetCursorPos([int]$X,[int]$Y)
    if ($Button -eq "right") { [AdvisNativeInput]::mouse_event([AdvisNativeInput]::RIGHTDOWN,0,0,0,[UIntPtr]::Zero); [AdvisNativeInput]::mouse_event([AdvisNativeInput]::RIGHTUP,0,0,0,[UIntPtr]::Zero) }
    else { [AdvisNativeInput]::mouse_event([AdvisNativeInput]::LEFTDOWN,0,0,0,[UIntPtr]::Zero); [AdvisNativeInput]::mouse_event([AdvisNativeInput]::LEFTUP,0,0,0,[UIntPtr]::Zero) }
  }
  "scroll" {
    if ($DeltaY -ne 0) {
      $ticks = [int](120 * [Math]::Min(10,[Math]::Ceiling([Math]::Abs($DeltaY)/100)))
      if ($DeltaY -gt 0) { $ticks = -$ticks }
      $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ticks),0)
      [AdvisNativeInput]::mouse_event([AdvisNativeInput]::WHEEL,0,0,$wheelData,[UIntPtr]::Zero)
    }
    if ($DeltaX -ne 0) {
      $ticks = [int](120 * [Math]::Min(10,[Math]::Ceiling([Math]::Abs($DeltaX)/100)))
      if ($DeltaX -gt 0) { $ticks = -$ticks }
      $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ticks),0)
      [AdvisNativeInput]::mouse_event([uint32]0x01000,0,0,$wheelData,[UIntPtr]::Zero)
    }
  }
  "key" {
    $special=@{ Enter=0x0D; Backspace=0x08; Tab=0x09; Escape=0x1B; ArrowUp=0x26; ArrowDown=0x28; ArrowLeft=0x25; ArrowRight=0x27; Delete=0x2E; Home=0x24; End=0x23; PageUp=0x21; PageDown=0x22; " "=0x20 }
    if ($Key.Length -eq 1) { $code=[int][char]$Key; [AdvisNativeInput]::keybd_event(0,[byte]$code,[AdvisNativeInput]::UNICODE,[UIntPtr]::Zero); [AdvisNativeInput]::keybd_event(0,[byte]$code,([AdvisNativeInput]::UNICODE -bor [AdvisNativeInput]::KEYUP),[UIntPtr]::Zero) }
    elseif ($special.ContainsKey($Key)) { $code=[byte]$special[$Key]; [AdvisNativeInput]::keybd_event($code,0,0,[UIntPtr]::Zero); [AdvisNativeInput]::keybd_event($code,0,[AdvisNativeInput]::KEYUP,[UIntPtr]::Zero) }
    else { throw "Unsupported key." }
  }
}