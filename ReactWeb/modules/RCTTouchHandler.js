/**
 * @providesModule RCTTouchHandler
 * @flow
 */

import type RCTBridge from "RCTBridge";

import detectIt from "detect-it";

import invariant from "Invariant";
import UIView from "UIView";
import RCTEventDispatcher from "RCTEventDispatcher";
import RCTTouchEvent from "RCTTouchEvent";
import guid from "Guid";

type UITouch = {
  view: UIView,
  identifier: number,
  pageX: number,
  pageY: number,
  locationX: number,
  locationY: number,
  timestamp: number
};

type ReactTouch = {
  target: number,
  identifier: number,
  pageX?: number,
  pageY?: number,
  locationX?: number,
  locationY?: number,
  timestamp?: number
};

const TOUCH_LISTENER_OPTIONS = detectIt.passiveEvents
  ? { passive: true, capture: true }
  : true;

class RCTTouchHandler {
  eventDispatcher: RCTEventDispatcher;

  nativeTouchesByIdentifier: { [number]: UITouch };
  nativeTouches: Array<UITouch>;
  reactTouches: Array<ReactTouch>;
  touchViews: Array<UIView>;
  coalescingKey: number;

  view: ?UIView;

  constructor(bridge: RCTBridge) {
    this.eventDispatcher = (bridge.moduleForClass(RCTEventDispatcher): any);

    this.nativeTouches = [];
    this.nativeTouchesByIdentifier = {};
    this.reactTouches = [];
    this.touchViews = [];
  }

  static RCTNormalizeInteractionEvent(
    rawEvent: TouchEvent | MouseEvent
  ): ?Array<UITouch> {
    if (rawEvent instanceof MouseEvent) {
      // rawEvent.preventDefault();
      const target = rawEvent.target;

      invariant(
        target instanceof UIView,
        "Cannot normalize interaction event on object which does not inherit from UIView"
      );

      if ("which" in rawEvent && rawEvent.which === 3) {
        return null;
      } else if ("button" in rawEvent && rawEvent.button === 2) {
        return null;
      }

      return [
        {
          view: target,
          identifier: 0,
          pageX: rawEvent.pageX,
          pageY: rawEvent.pageY,
          locationX: rawEvent.offsetX,
          locationY: rawEvent.offsetY,
          timestamp: rawEvent.timeStamp
        }
      ];
    } else if (rawEvent.changedTouches) {
      rawEvent.preventDefault();

      const rawTouches = rawEvent.changedTouches;
      const resultingTouchList = [];

      for (let i = 0; i < rawTouches.length; i++) {
        const rawTouch = rawTouches[i];
        const target = rawTouch.target;

        invariant(
          target instanceof UIView,
          "Cannot normalize interaction event on object which does not inherit from UIView"
        );

        resultingTouchList.push({
          view: target,
          identifier: rawTouch.identifier % 20,
          pageX: rawTouch.pageX,
          pageY: rawTouch.pageY,
          locationX: rawTouch.clientX,
          locationY: rawTouch.clientY,
          timestamp: rawEvent.timeStamp
        });
      }

      return resultingTouchList;
    }

    console.error(rawEvent);
    throw new Error("Invalid Event");
  }

  attachToView(view: UIView) {
    this.view = view;
    view.addGestureRecognizer(
      this,
      detectIt.deviceType,
      TOUCH_LISTENER_OPTIONS
    );
  }

  detachFromView(view: UIView) {
    this.view = undefined;
    view.removeGestureRecognizer(
      this,
      detectIt.deviceType,
      TOUCH_LISTENER_OPTIONS
    );
  }

  recordNewTouches(touches: Array<UITouch>) {
    touches.forEach(touch => {
      invariant(
        !this.nativeTouchesByIdentifier.hasOwnProperty(touch.identifier),
        "Touch is already recorded. This is a critical bug"
      );

      // Find closest React-managed touchable element
      let targetView = (touch.view: any);
      while (targetView) {
        if (targetView === this.view) break;
        if (targetView.reactTag && targetView.touchable) break;
        targetView = targetView.parentElement;
      }

      const reactTag = targetView.reactTag;
      const touchID = touch.identifier;

      // Create touch
      const reactTouch = {
        target: reactTag,
        identifier: touchID
      };

      // Add to arrays
      this.touchViews.push(targetView);
      this.nativeTouches.push(touch);
      this.nativeTouchesByIdentifier[touchID] = touch;
      this.reactTouches.push(reactTouch);
    });
  }

  recordRemovedTouches(touches: Array<UITouch>) {
    for (let touch of touches) {
      const nativeTouch = this.nativeTouchesByIdentifier[touch.identifier];

      if (!nativeTouch) {
        continue;
      }

      const index = this.nativeTouches.indexOf(nativeTouch);

      this.touchViews.splice(index, 1);
      this.nativeTouches.splice(index, 1);
      delete this.nativeTouchesByIdentifier[touch.identifier];
      this.reactTouches.splice(index, 1);
    }
  }

  updateReactTouch(touchIndex: number) {
    const nativeTouch = this.nativeTouches[touchIndex];

    const updatedReactTouch = {
      ...this.reactTouches[touchIndex],
      pageX: nativeTouch.pageX,
      pageY: nativeTouch.pageY,
      locationX: nativeTouch.locationX,
      locationY: nativeTouch.locationY,
      timestamp: nativeTouch.timestamp
    };

    // TODO force touch

    this.reactTouches[touchIndex] = updatedReactTouch;
  }

  updateAndDispatchTouches(touches: Array<UITouch>, eventName: string) {
    const changedIndexes = [];
    for (let touch of touches) {
      const nativeTouch = this.nativeTouchesByIdentifier[touch.identifier];
      if (!nativeTouch) {
        console.log("updateAndDispatch failed");
        continue;
      }

      const index = this.nativeTouches.indexOf(nativeTouch);

      if (index === -1) continue;

      this.updateReactTouch(index);
      changedIndexes.push(index);
    }

    if (changedIndexes.length === 0) {
      console.log("no changed Indexes");
      return;
    }

    const reactTouches = this.reactTouches.map(reactTouch => ({
      ...reactTouch
    }));

    const canBeCoalesced = eventName === "touchMove";

    if (!canBeCoalesced) {
      this.coalescingKey++;
    }

    invariant(this.view, "attempting to send event to unknown view");

    const event = new RCTTouchEvent(
      eventName,
      this.view.reactTag,
      reactTouches,
      changedIndexes,
      this.coalescingKey
    );

    if (!canBeCoalesced) {
      this.coalescingKey++;
    }

    this.eventDispatcher.sendEvent(event);
  }

  mouseClickBegan = (event: MouseEvent) => {
    const touches = RCTTouchHandler.RCTNormalizeInteractionEvent(event);
    if (!touches) return;

    this.touchesBegan(touches);

    const view = this.view;
    if (view) {
      view.addEventListener("mouseup", this.mouseClickEnded);
      view.addEventListener("mousemove", this.mouseClickMoved);
    }
  };

  mouseClickMoved = (event: MouseEvent) => {
    const touches = RCTTouchHandler.RCTNormalizeInteractionEvent(event);
    if (!touches) return;

    this.touchesMoved(touches);
  };

  mouseClickEnded = (event: MouseEvent) => {
    const touches = RCTTouchHandler.RCTNormalizeInteractionEvent(event);
    if (!touches) return;

    this.touchesEnded(touches);

    const view = this.view;
    if (view) {
      view.removeEventListener("mouseup", this.mouseClickEnded);
      view.removeEventListener("mousemove", this.mouseClickMoved);
    }
  };

  nativeTouchBegan = (event: TouchEvent) => {
    const touches = RCTTouchHandler.RCTNormalizeInteractionEvent(event);
    if (!touches) return;

    this.touchesBegan(touches);

    const view = this.view;
    if (view) {
      view.addEventListener(
        "touchend",
        this.nativeTouchEnded,
        TOUCH_LISTENER_OPTIONS
      );
      view.addEventListener(
        "touchmove",
        this.nativeTouchMoved,
        TOUCH_LISTENER_OPTIONS
      );
    }
  };

  nativeTouchMoved = (event: TouchEvent) => {
    const touches = RCTTouchHandler.RCTNormalizeInteractionEvent(event);
    if (!touches) return;

    this.touchesMoved(touches);
  };

  nativeTouchEnded = (event: TouchEvent) => {
    const touches = RCTTouchHandler.RCTNormalizeInteractionEvent(event);
    if (!touches) return;

    this.touchesEnded(touches);

    const view = this.view;
    if (view) {
      view.removeEventListener(
        "touchend",
        this.nativeTouchEnded,
        TOUCH_LISTENER_OPTIONS
      );
      view.removeEventListener(
        "touchmove",
        this.nativeTouchMoved,
        TOUCH_LISTENER_OPTIONS
      );
    }
  };

  touchesBegan(touches: Array<UITouch>) {
    // console.log("touch began");
    this.recordNewTouches(touches);
    this.updateAndDispatchTouches(touches, "touchStart");
  }

  touchesMoved(touches: Array<UITouch>) {
    // console.log("touch moved");
    this.updateAndDispatchTouches(touches, "touchMove");
  }

  touchesEnded(touches: Array<UITouch>) {
    // console.log("touch ended");
    this.updateAndDispatchTouches(touches, "touchEnd");
    this.recordRemovedTouches(touches);
  }
}

export default RCTTouchHandler;