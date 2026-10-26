FROM archlinux:base@sha256:52dfbd5afb23a220d5ee92dafcb4c788d96c026ed04179890c23adef4c897fa0
RUN pacman -Sy --noconfirm archlinux-keyring && pacman -Syu --noconfirm base-devel desktop-file-utils xorg-server-xvfb xorg-xauth curl python python-websocket-client ttf-dejavu && pacman -Scc --noconfirm
