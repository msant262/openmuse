/** Layout/streaming scroll events are not evidence that the reader scrolled away. */
export class ChatScrollFollow {
  following = true;
  private userScrolling = false;
  private offset = 0;
  latest() {
    this.following = true;
    this.userScrolling = false;
  }
  pause() {
    this.following = false;
    this.userScrolling = false;
  }
  beginUserScroll() {
    this.userScrolling = true;
  }
  endUserScroll() {
    this.userScrolling = false;
  }
  scroll(offset: number, contentHeight: number, viewportHeight: number) {
    const nearEnd = contentHeight - offset - viewportHeight <= 80;
    if (nearEnd) this.following = true;
    else if (this.userScrolling && offset < this.offset - 1) this.following = false;
    this.offset = offset;
    return !this.following;
  }
}
