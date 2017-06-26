/**
 * @providesModule RCTBridge
 * @flow
 */
import invariant from "Invariant";
import { moduleConfigFactory, ModuleConfig } from "RCTModuleConfig";
import {
  RCTFunctionTypeNormal,
  RCTFunctionTypePromise,
  RCTFunctionTypeSync,
  RCTFunctionType,
} from "RCTBridgeMethod";

export {
  RCTFunctionTypeNormal,
  RCTFunctionTypePromise,
  RCTFunctionTypeSync,
  RCTFunctionType,
};

type MessagePayload = {
  data: {
    topic: string,
    payload: any,
  },
};

type NativeCall = {
  moduleId: number,
  methodId: number,
  args: Array<any>,
};

const MODULE_IDS = 0;
const METHOD_IDS = 1;
const PARAMS = 2;

const DEVTOOLS_FLAG = /\bdevtools\b/;
const HOTRELOAD_FLAG = /\bhotreload\b/;

let WORKER_SRC = `
ErrorUtils = {
  setGlobalHandler: () => {},
  reportFatalError: console.error,
};

function sendMessage(topic, payload) {
  postMessage({ topic, payload });
}

var Status = undefined;

onmessage = ({ data: { topic, payload } }) => {
  // console.log("Recieved message from main thread:", topic, payload);

  switch (topic) {
    case "loadBridgeConfig": {
      const { config, bundle } = payload;

      __fbBatchedBridgeConfig = config;
      importScripts(bundle);

      sendMessage("bundleFinishedLoading");
      break;
    }
    case "callFunctionReturnFlushedQueue": {
      const batchedBridge = __fbBatchedBridge;
      const flushedQueue = batchedBridge.callFunctionReturnFlushedQueue(
        ...payload
      );
      sendMessage("flushedQueue", flushedQueue);
      break;
    }
  }
};
`;

if (__DEV__) {
  if (DEVTOOLS_FLAG.test(location.search)) {
    WORKER_SRC += "__DEVTOOLS__ = true;\n";
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      console.log(
        "We detected that you have the React Devtools extension installed. " +
          "Please note that at this time, React VR is only compatible with the " +
          "standalone React Native Inspector that ships with Nuclide."
      );
    }
  }
}

export interface ModuleClass {
  static __moduleName: ?string,
  setBridge?: RCTBridge => void,
  constantsToExport?: () => { [string]: any },
  [string]: ?Function,
}

export function getPropertyNames(obj: ?Object): Array<string> {
  if (obj == null) return [];

  const currentPropertyNames = Object.getOwnPropertyNames(obj);
  return currentPropertyNames.concat(
    getPropertyNames(Object.getPrototypeOf(obj))
  );
}

export function bridgeModuleNameForClass(cls: Class<ModuleClass>): string {
  let name = cls.__moduleName;

  if (name != null) {
    if (name.startsWith("RK")) {
      name = name.substring(2);
    } else if (name.startsWith("RCT")) {
      name = name.substring(3);
    }
    return name;
  }

  return "";
}

function generateModuleConfig(name: string, bridgeModule: ModuleClass) {
  const methodNames = [
    ...new Set(getPropertyNames(bridgeModule)),
  ].filter(methodName => methodName.startsWith("__rct_export__"));

  const constants = bridgeModule.constantsToExport
    ? bridgeModule.constantsToExport()
    : undefined;

  const allMethods = [];
  const promiseMethods = [];
  const syncMethods = [];

  methodNames.forEach(rctName => {
    if (bridgeModule[rctName]) {
      const [methodName, methodType] = bridgeModule[rctName].call(bridgeModule);
      allMethods.push(methodName);

      if (methodType === RCTFunctionTypePromise) {
        promiseMethods.push(allMethods.length - 1);
      }

      if (methodType === RCTFunctionTypeSync) {
        syncMethods.push(allMethods.length - 1);
      }
    }
  });

  return [name, constants, allMethods, promiseMethods, syncMethods];
}

export default class RCTBridge {
  static RCTModuleClasses: Array<Class<ModuleClass>> = [];

  static RCTRegisterModule = (cls: Class<ModuleClass>) => {
    RCTBridge.RCTModuleClasses.push(cls);
  };

  modulesByName: { [name: string]: ModuleClass } = {};
  moduleClasses: Array<Class<ModuleClass>> = [];
  moduleConfigs: Array<ModuleConfig> = [];
  bundleFinishedLoading: ?() => void;
  messages: Array<NativeCall> = [];
  moduleName: string;
  bundleLocation: string;

  constructor(moduleName: string, bundle: string) {
    this.moduleName = moduleName;
    this.bundleLocation = bundle;

    const bridgeCodeBlob = new Blob([WORKER_SRC]);
    const worker = new Worker(URL.createObjectURL(bridgeCodeBlob));
    this.setThread(worker);
  }

  moduleForClass(cls: Class<ModuleClass>): ModuleClass {
    invariant(cls.__moduleName, "Class does not seem to be exported");
    return this.modulesByName[bridgeModuleNameForClass(cls)];
  }

  queue: Array<any> = [];
  executing: boolean = false;
  thread: ?Worker;

  setThread(thread: Worker) {
    this.thread = thread;
    thread.onmessage = this.onMessage.bind(this);
  }

  sendMessage(topic: string, payload: any) {
    if (this.thread) {
      this.thread.postMessage({ topic, payload });
    }
  }

  callNativeModule(moduleId: number, methodId: number, params: Array<any>) {
    const moduleConfig = this.moduleConfigs[moduleId];

    invariant(moduleConfig, `No such module with id: ${moduleId}`);
    const [name, , functions] = moduleConfig;

    invariant(functions, `Module ${name} has no methods to call`);
    const functionName = functions[methodId];

    invariant(
      functionName,
      `No such function in module ${name} with id ${methodId}`
    );
    const nativeModule = this.modulesByName[name];

    invariant(nativeModule, `No such module with name ${name}`);
    invariant(
      nativeModule[functionName],
      `No such method ${functionName} on module ${name}`
    );
    nativeModule[functionName].apply(nativeModule, params);
  }

  onMessage(message: any) {
    const { topic, payload } = (message.data: {
      topic: string,
      payload: ?any,
    });
    // console.log("Recieved message from worker thread:", topic, payload);

    switch (topic) {
      case "bundleFinishedLoading": {
        if (this.bundleFinishedLoading) {
          this.bundleFinishedLoading();
        }
        break;
      }
      case "flushedQueue": {
        if (payload != null && Array.isArray(payload)) {
          const [moduleIds, methodIds, params] = payload;
          for (let i = 0; i < moduleIds.length; i++) {
            this.messages.push({
              moduleId: moduleIds[i],
              methodId: methodIds[i],
              args: params[i],
            });
          }
        }
        break;
      }
      default: {
        console.log(`Unknown topic: ${topic}`);
      }
    }
  }

  initializeModules = () => {
    this.moduleClasses = [...RCTBridge.RCTModuleClasses];
    RCTBridge.RCTModuleClasses.forEach((moduleClass: Class<ModuleClass>) => {
      const module = new moduleClass(this);
      const moduleName = bridgeModuleNameForClass(moduleClass);
      this.modulesByName[moduleName] = module;
    });
  };

  generateModuleConfig(name: string, bridgeModule: ModuleClass) {
    const methodNames = [
      ...new Set(getPropertyNames(bridgeModule)),
    ].filter(methodName => methodName.startsWith("__rct_export__"));

    const constants = bridgeModule.constantsToExport
      ? bridgeModule.constantsToExport()
      : undefined;

    const allMethods = [];
    const promiseMethods = [];
    const syncMethods = [];

    methodNames.forEach(rctName => {
      if (bridgeModule[rctName]) {
        const [methodName, methodType] = bridgeModule[rctName].call(
          bridgeModule
        );
        allMethods.push(methodName);

        if (methodType === RCTFunctionTypePromise) {
          promiseMethods.push(allMethods.length - 1);
        }

        if (methodType === RCTFunctionTypeSync) {
          syncMethods.push(allMethods.length - 1);
        }
      }
    });
    this.moduleConfigs.push(
      moduleConfigFactory(
        name,
        constants,
        allMethods,
        promiseMethods,
        syncMethods
      )
    );
    return [name, constants, allMethods, promiseMethods, syncMethods];
  }

  loadBridgeConfig() {
    const config = this.getInitialModuleConfig();
    this.sendMessage("loadBridgeConfig", {
      config,
      bundle: this.bundleLocation,
    });
  }

  getInitialModuleConfig = () => {
    const remoteModuleConfig = Object.keys(
      this.modulesByName
    ).map(moduleName => {
      const bridgeModule = this.modulesByName[moduleName];
      return this.generateModuleConfig(moduleName, bridgeModule);
    });
    return { remoteModuleConfig };
  };

  enqueueJSCall = (
    moduleName: string,
    methodName: string,
    args: Array<any>
  ) => {
    this.sendMessage("callFunctionReturnFlushedQueue", [
      moduleName,
      methodName,
      args,
    ]);
  };

  frame() {
    const frameStart = window.performance ? performance.now() : Date.now();

    const messages = [...this.messages];
    this.messages = [];
    messages.forEach(({ moduleId, methodId, args }) => {
      this.callNativeModule(moduleId, methodId, args);
    });
  }
}

export function RCT_EXPORT_METHOD(type: RCTFunctionType) {
  return (target: any, key: any, descriptor: any) => {
    if (typeof descriptor.value === "function") {
      Object.defineProperty(
        target,
        // `__rct_export__${key}__${getNextModuleCounterValue()}`,
        `__rct_export__${key}`,
        {
          ...descriptor,
          value: () => [key, type],
        }
      );
    }

    return descriptor;
  };
}

export const RCT_EXPORT_MODULE = (target: Class<ModuleClass>) => {
  target.__moduleName = target.prototype.constructor.name;
  RCTBridge.RCTRegisterModule(target);
};