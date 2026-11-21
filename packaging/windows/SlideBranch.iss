#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
[Setup]
AppId=SlideBranch.Workbench
AppName=SlideBranch
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\SlideBranch
DefaultGroupName=SlideBranch
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=SlideBranch-Setup-x64
OutputDir=..\..\target\windows-installer
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\SlideBranch.exe

[Files]
Source: "{#ImageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\SlideBranch"; Filename: "{app}\SlideBranch.exe"
Name: "{userdesktop}\SlideBranch"; Filename: "{app}\SlideBranch.exe"

[Run]
Filename: "{app}\SlideBranch.exe"; Description: "Launch SlideBranch"; Flags: nowait postinstall skipifsilent
