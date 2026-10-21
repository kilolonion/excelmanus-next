# Real macro-enabled workbook test fixture

This base64 is the unmodified Apache POI `SimpleMacro.xlsm` test workbook, not a fabricated VBA sentinel or an empty macro-enabled shell.

- Upstream: https://github.com/apache/poi/blob/d91a76448f0963a93b6cd95fb97fbe1d8bad82c6/test-data/spreadsheet/SimpleMacro.xlsm
- Pinned commit: `d91a76448f0963a93b6cd95fb97fbe1d8bad82c6`
- Git blob: `ec64525bf8fa45bb56e9b50dce90189590323d1a`
- Original bytes: 13,796; SHA-256: `f76c986f4ebc25c2cc57c088b2511a1269f4bd61d6223a2ab58db351da348ba6`
- `xl/vbaProject.bin`: 16,384 bytes; SHA-256: `f9becb822f01de291b0ec95ea4061235e1f98ea31f80d840009a6caab829ce90`
- License: Apache-2.0. The original POI LICENSE and NOTICE are reproduced in full, with labeled boundaries, in `real-macro.LICENSE.txt`.

Tests may decode the ZIP, hash opaque VBA bytes, and inspect OOXML relationships, content types and code names. Never execute VBA, enable active content, or launch Office/LibreOffice from these tests. A preserved static project does not establish native Excel opening without repair or successful macro execution. Synthetic mutations of this fixture are only negative controls, never presented as independently usable workbooks.
