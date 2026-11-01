# Photo regression test

Put real photos of a sender screen in this folder. `test/photos.test.js` decodes each group of photos through the camera reader and checks the result against an `.expected` file.

## Taking a photo

1. On the sender, go full screen with 16 px blocks and 4 levels, and send a short message.
2. Use the phone's normal camera app. Do not zoom. Hold the phone steady and keep the whole screen in view.
3. Save the photo as JPEG or PNG and copy it into this folder.

## Naming

- One frame transmission: `<scene>.jpg`, for example `laptop-6ft.jpg`.
- Multi frame transmission: `<scene>-01.jpg`, `<scene>-02.jpg` and so on. All of them belong to the group `<scene>`.

## The `.expected` file

Next to the photos, add `<scene>.expected`. It holds the exact bytes that were sent. For a message, write the message text with no trailing newline. For a file, copy the original file. A group with no `.expected` file is skipped.

## Git

Photos and `.expected` files are git ignored. Only this README is tracked.

## Running

```
node tools/decode-photo.js test/photos/laptop-6ft.jpg
node --test test/photos.test.js
```

The tool prints what each stage found, so you can see where a failing photo goes wrong.
