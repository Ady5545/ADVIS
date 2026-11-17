# macOS permissions and input capability

The desktop agent uses Apple System Events UI scripting for mouse clicks and keystrokes. macOS requires the user to grant Accessibility permission to ADVIS Desktop Agent. Screen capture separately requires Screen Recording permission. The agent opens the relevant System Settings panes only after the user clicks its permission button.

The current macOS adapter supports click, text/key input and basic navigation keys. Hover movement and scroll injection are not implemented by this adapter. Do not advertise it as a complete remote-desktop replacement until those capabilities pass hands-on testing on a signed and notarised Apple Silicon build.