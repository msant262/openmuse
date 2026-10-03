# Mobile inputs and conversation resources

The Android app can stage documents, camera images, recorded audio and items shared
from another app. Staging does not send a message. Attach the saved file to a
request explicitly; its ID and hash enter the durable message outbox. Local
staging is scoped to the paired device and conversation, with eight pending
items and a 25 MB limit per file. Network failures preserve the pending item.

Audio recording stops when the app leaves the foreground and has a 30 minute
limit. Transcription uses the native Lenovo computer and its offline Whisper
small model on CPU/int8. It does not send audio through Sign in with ChatGPT.
Automatic language detection supports Portuguese, English and German; the
result records language, confidence and duration. The complete `.txt`, and an
optional `.srt`, are copied into the VPS file store and shown as downloadable
cards. Bounded command stdout is never presented as the complete transcript.

Transcription is a durable task under the same four-slot scheduler. Closing the
phone does not cancel it. A stable request ID, operation receipts and output
identities recover the accepted job and publication separately: a disconnected
Lenovo can postpone file publication without starting transcription again.
Published files remain accessible when the Lenovo is offline. Removing a staged
item does not cancel an already accepted task; use the explicit task controls.

The conversation Resources view groups files, source references and browser or
desktop sessions belonging to that conversation. Files may be attached to a new
request. Image and desktop annotations retain the original asset/frame identity,
dimensions and normalized geometry. An annotation supplies context; it does not
authorize a click against a newer frame or another session. Private credential
cards keep their separate direct submission path.

The app still needs Android microphone/camera permission when those inputs are
used. Physical keyboard, share-sheet, lock/reopen, background upload and push
acceptance are deployment checks, separate from the automated queue tests and
native APK build. See [the hybrid deployment guide](../DEPLOY.md) and
[proactive review](PROACTIVITY.md).
