# Existing external workbook link

`external-links.xlsx.base64` decodes to the unmodified ClosedXML MIT fixture:
https://github.com/ClosedXML/ClosedXML/blob/09f2f21a60e821ce7fb18ca3576b272e5dd6d921/ClosedXML.Tests/Resource/Other/ExternalLinks/WorkbookWithExternalLink.xlsx

SHA256: c83865c79e2fb92b98c9859f5952a2f7897d9022e0d5db7e278087a4b9c03ee0.
Copyright (c) 2016 ClosedXML. See external-links.LICENSE.txt.

The real existing B2 formula and worksheet cache refer to an externalLink part
with its own saved cache and a relative `book1.xlsx` relationship.

`book1.xlsx.base64` is the locally authored companion, exported with ArtifactTool.
Its Sheet1!A1 is `hello world`; its workbook uses valid standard `x:` namespace
prefixes. SHA256: 89774a97de49613d58f015db411e9e164f239257b32055a1f4086a69e3e532ff.

Tests only parse and preserve package contents. They never update links, access
the relationship target automatically, execute macros, or claim native Excel validation.
