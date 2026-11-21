# Video maker

Use this to make an animated video with a voice-over (Bangla or English), and optionally post it on the user's Facebook Page. Everything here is free and runs on this computer.

## 0. Check the computer
Run the `media_check` tool (Media tools plugin) or check by hand: Node.js + npm (needed), FFmpeg (needed only for plain clip/slide videos; Remotion brings its own encoder), the installed voices. Tell the user exactly what is missing and the one command that installs it. Do not continue without what the chosen route needs.

## 1. Agree on the video first (short)
Ask only what is missing: topic and story, language (Bangla / English), length, shape — **9:16 1080x1920 for Reels and Shorts**, 16:9 1920x1080 for normal videos — style (cartoon, kinetic text, slides), and whether it should be posted. Then write a **scene list**: for each scene the narration line, what is on screen, and the motion.

## 2. The voice-over, one file per scene
- Offline Windows voices: `voice_over` tool, one call per scene (`out: audio/scene-01.wav` ...). It reports each file's length: that length is the scene's length.
- If the user gives their own recording, use it and cut it per scene with FFmpeg.
- Never claim a voice exists that `media_check` did not list. If no voice for the language is installed, say so and offer: the user's own recording, an installed language voice, or text-only captions.

## 3. Animation with Remotion (React)
1. Create the project inside the workspace: `npx create-video@latest --yes --blank video` (then `cd video && npm install`).
2. One composition at the agreed size and 30 fps. One `<Sequence>` per scene; its duration = the voice file length × fps, rounded up. Put the audio with `<Audio src={staticFile("audio/scene-01.wav")} />` inside the same sequence (files go in `video/public/`).
3. Motion: use `useCurrentFrame()` with `interpolate()` / `spring()` for entrances, movement and emphasis. Keep text large, high contrast and inside the safe area (no text in the top 10% and bottom 20% of a 9:16 video). Bangla text: use a font that has Bangla letters (e.g. "Noto Sans Bengali", "Hind Siliguri") and check that letters render correctly, not as boxes.
4. Captions: show the narration line of the current scene, a few words at a time, synced to the scene.
5. Preview single frames before the full render: `npx remotion still <id> out/check.png --frame=<n>` and look at them. Fix overlaps, cut-off text and wrong timing.
6. Render: `npx remotion render <id> out/video.mp4 --codec=h264 --audio-codec=aac`. Long renders: run in the background and tell the user it is rendering. On a slow computer use `--concurrency=2` and render a 720p draft first.

## 4. Check the result
`ffprobe` (or Remotion's output) for size, fps, duration and that there is an audio track. Look at 3-4 frames. A Reel must be 9:16, 3-90 seconds, at least 540x960, H.264 + AAC.

## 5. Post on Facebook (only when asked)
- `facebook_pages` to pick the Page.
- `facebook_upload_video` with `reel: true` for a vertical 3-90 s video, otherwise a normal video. Default is an unpublished draft; `publish: true` posts publicly and the user is always asked first.
- `facebook_video_status` until it is `ready`, then give the user the link.

## Report
The video file path, length, size, the voice used, and the Facebook link if posted. Mention anything that could not be done.
