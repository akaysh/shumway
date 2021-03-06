/**
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

module Shumway.Timeline {
  import notImplemented = Shumway.Debug.notImplemented;
  import isInteger = Shumway.isInteger;
  import assert = Shumway.Debug.assert;
  import warning = Shumway.Debug.warning;
  import abstractMethod = Shumway.Debug.abstractMethod;
  import Bounds = Shumway.Bounds;
  import ColorUtilities = Shumway.ColorUtilities;
  import flash = Shumway.AVM2.AS.flash;

  import ActionScriptVersion = flash.display.ActionScriptVersion;

  export interface IAssetResolver {
    registerFontOrImage(symbol: Timeline.EagerlyResolvedSymbol, data: any): void;
  }

  export interface EagerlyResolvedSymbol {
    syncId: number;
    id: number;
    ready: boolean;
    resolveAssetPromise: PromiseWrapper<any>;
    resolveAssetCallback: (data: any) => void;
  }

  export interface SymbolData {id: number; className: string}
  /**
   * TODO document
   */
  export class Symbol {
    ready: boolean;
    resolveAssetPromise: PromiseWrapper<any>;
    data: any;
    isAVM1Object: boolean;
    avm1Context: Shumway.AVM1.AVM1Context;
    symbolClass: Shumway.AVM2.AS.ASClass;

    constructor(data: SymbolData, symbolDefaultClass: Shumway.AVM2.AS.ASClass) {
      release || assert (isInteger(data.id));
      this.data = data;
      if (data.className) {
        var appDomain = Shumway.AVM2.Runtime.AVM2.instance.applicationDomain;
        try {
          var symbolClass = appDomain.getClass(data.className);
          this.symbolClass = symbolClass;
        } catch (e) {
          warning ("Symbol " + data.id + " bound to non-existing class " + data.className);
          this.symbolClass = symbolDefaultClass;
        }
      } else {
        this.symbolClass = symbolDefaultClass;
      }
      this.isAVM1Object = false;
    }

    get id(): number {
      return this.data.id;
    }
  }

  export class DisplaySymbol extends Symbol {
    fillBounds: Bounds;
    lineBounds: Bounds;
    scale9Grid: Bounds;
    dynamic: boolean;

    constructor(data: SymbolData, symbolClass: Shumway.AVM2.AS.ASClass, dynamic: boolean) {
      super(data, symbolClass);
      this.dynamic = dynamic;
    }

    _setBoundsFromData(data: any) {
      this.fillBounds = data.fillBounds ? Bounds.FromUntyped(data.fillBounds) : null;
      this.lineBounds = data.lineBounds ? Bounds.FromUntyped(data.lineBounds) : null;
      if (!this.lineBounds && this.fillBounds) {
        this.lineBounds = this.fillBounds.clone();
      }
    }
  }

  export class BinarySymbol extends Symbol {
    buffer: Uint8Array;
    byteLength: number;

    constructor(data: SymbolData) {
      super(data, flash.utils.ByteArray);
    }

    static FromData(data: any): BinarySymbol {
      var symbol = new BinarySymbol(data);
      symbol.buffer = data.data;
      symbol.byteLength = data.data.byteLength;
      return symbol;
    }
  }

  export class SoundStart {
    constructor(public soundId: number, public soundInfo) {
    }
  }
}
