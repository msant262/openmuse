# Google Drive name search: cause, correction and live acceptance

## Observed failure

The reported task searched for the exact folder name `MOVING DE` in both connected accounts. It broadened the name only in the first account before asking the user for access. The folder was accessible in the second account as `MovingDE`; later receipts from the same task found it and listed 35 children. Missing OAuth permission was not the cause of this failed lookup.

Google's `name contains` operator matches prefixes. The harness must account for spelling and spacing variations and must search the requested accounts before concluding absence. [Official Drive search terms](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)

## Correction

`search_drive` accepts a plain name, an optional account, an optional parent folder and a file/folder filter. Without an account it searches every connected Google account. The server builds escaped native queries for the original spelling, compact spelling and meaningful terms, ranks name matches, retains navigable shortcut metadata and follows all provider pages. The result carries the owning account and observed coverage. A bounded shortlist does not stop pagination or reduce the total item count.

The tool uses the existing native Google account authority and read executor. It is available directly for Drive-related task requests; the remaining Workspace catalog stays lazy. Missing scopes, account errors, limited `drive.file` visibility, repeated page tokens and Google's `incompleteSearch` flag cannot become a successful empty search or evidence that a folder does not exist. Search metadata is not evidence of document contents.

Automated coverage includes the empty-first-account/name-variation failure, pagination beyond a result limit, selected accounts, shortcuts, partial errors/scopes, cancellation, query escaping, file/folder filtering and the actual harness/native executor. The final Drive and Workspace group passed **29/29**, with root TypeScript and the Docker server/harness compilation passing. Additional routing/verification suites passed earlier; those groups overlap.

## Ordinary production chat acceptance

The production chat received only:

> Encontre a pasta MOVING DE no meu Google Drive e me diga em qual conta está e quantos arquivos há nela.

No tool name, API command, card instruction or model override was supplied. The configured model remained `chatgpt/gpt-6-luna`. The task made exactly two native `search_drive` calls: a folder search across both accounts, then a parent-folder listing on the account that owns the match. Both operation receipts succeeded with complete coverage; there were no failed operations and the task completion was verified from those receipts.

The UI reported `MovingDE`, its actual owning account, 35 items (files and subfolders) and the folder link. The task ran from 16:24:21 to 16:24:35 UTC on 2026-10-09; the completed reply was observed less than 30 seconds after submitting the request. This is acceptance of lookup and folder listing, not of immigration advice or reading every document.

Private receipts identify conversation `3d0e9966-d175-4b92-bf15-e9531916fafe` and task `573b3bdc31eac4e13d57b9832891013c2fffcce993e40041f8fe094b2b6917d2`. Own diagnostic conversations/tasks and paired devices are removed after validation. Original conversations, companions, Google accounts and Drive documents are preserved.

## Publication

The code release `f938864f` was pushed to `main` and published to the existing API. A first publication attempt stopped because the previous API returned a nonzero shutdown status; its original image was restarted and confirmed healthy. The subsequent guarded publication confirmed exit zero, used the existing database without replacement, preserved the environment hash, Google connections, pause revision and historical operation records, and returned healthy with maintenance released.

The final follow-up adds file-only query filtering and this acceptance record. It does not change the model, frontend bundle, APK, connected-account configuration or deletion approval policy. Deployment and diagnostic receipts are private under `/root/okami-deployment/drive-search-20261009/`, with ignored local artifacts under `artifacts/drive-search-20261009/`.
