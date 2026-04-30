#!/bin/bash
# Window scanner helper - runs osascript (inherits TCC from GUI context)
/usr/bin/osascript -e '
set output to "[\n"
tell application "System Events"
  set visibleProcs to every process whose visible is true
  set firstItem to true
  repeat with p in visibleProcs
    try
      set procName to name of p
      repeat with w in every window of p
        try
          set winName to name of w
          if winName is not "" then
            if firstItem then
              set firstItem to false
            else
              set output to output & ",\n"
            end if
            set output to output & "  {\"app\": " & quoted form of procName & ", \"title\": " & quoted form of winName & "}"
          end if
        end try
      end repeat
    end try
  end repeat
end tell
set output to output & "\n]"
return output
'
