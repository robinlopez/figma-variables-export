console.clear();

function createCollection(name) {
  const collection = figma.variables.createVariableCollection(name);
  const modeId = collection.modes[0].modeId;
  return { collection, modeId };
}

function createToken(collection, modeId, type, name, value) {
  const token = figma.variables.createVariable(name, collection, type);
  token.setValueForMode(modeId, value);
  return token;
}

function createVariable(collection, modeId, key, valueKey, tokens) {
  const token = tokens[valueKey];
  return createToken(collection, modeId, token.resolvedType, key, {
    type: "VARIABLE_ALIAS",
    id: `${token.id}`,
  });
}

function importJSONFile({ fileName, body }) {
  const json = JSON.parse(body);
  const { collection, modeId } = createCollection(fileName);
  const aliases = {};
  const tokens = {};
  Object.entries(json).forEach(([key, object]) => {
    traverseToken({
      collection,
      modeId,
      type: json.$type,
      key,
      object,
      tokens,
      aliases,
    });
  });
  processAliases({ collection, modeId, aliases, tokens });
}

function processAliases({ collection, modeId, aliases, tokens }) {
  aliases = Object.values(aliases);
  let generations = aliases.length;
  while (aliases.length && generations > 0) {
    for (let i = 0; i < aliases.length; i++) {
      const { key, type, valueKey } = aliases[i];
      const token = tokens[valueKey];
      if (token) {
        aliases.splice(i, 1);
        tokens[key] = createVariable(collection, modeId, key, valueKey, tokens);
      }
    }
    generations--;
  }
}

function isAlias(value) {
  return value.toString().trim().charAt(0) === "{";
}

function traverseToken({
                         collection,
                         modeId,
                         type,
                         key,
                         object,
                         tokens,
                         aliases,
                       }) {
  type = type || object.$type;
  if (key.charAt(0) === "$") {
    return;
  }
  if (object.$value !== undefined) {
    if (isAlias(object.$value)) {
      const valueKey = object.$value
          .trim()
          .replace(/\./g, "/")
          .replace(/[\{\}]/g, "");
      if (tokens[valueKey]) {
        tokens[key] = createVariable(collection, modeId, key, valueKey, tokens);
      } else {
        aliases[key] = {
          key,
          type,
          valueKey,
        };
      }
    } else if (type === "color") {
      tokens[key] = createToken(
          collection,
          modeId,
          "COLOR",
          key,
          parseColor(object.$value)
      );
    } else if (type === "number") {
      tokens[key] = createToken(
          collection,
          modeId,
          "FLOAT",
          key,
          object.$value
      );
    } else {
      console.log("unsupported type", type, object);
    }
  } else {
    Object.entries(object).forEach(([key2, object2]) => {
      if (key2.charAt(0) !== "$") {
        traverseToken({
          collection,
          modeId,
          type,
          key: `${key}/${key2}`,
          object: object2,
          tokens,
          aliases,
        });
      }
    });
  }
}

function toCamelCase(str) {
  return str
      .replace(/[^\w\s-]/g, '')
      .trim()
      .split(/[\s-_]+/)
      .map((word, index) => {
        if (index === 0) {
          return word.toLowerCase();
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join('');
}

function needsQuotes(key) {
  return /^[0-9]/.test(key) || /[^a-zA-Z0-9_$]/.test(key);
}

function formatObjectKey(key) {
  const camelKey = toCamelCase(key);
  return needsQuotes(camelKey) ? `'${camelKey}'` : camelKey;
}

async function exportToJSON(options = {}) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const files = [];
  const collectionsInfo = {}; // Nouveau : info sur les collections

  for (const collection of collections) {
    const file = await processCollectionCustom(collection, options);
    files.push(file);

    // Nouveau : stocker les modes disponibles
    collectionsInfo[collection.name] = {
      modes: collection.modes.map(m => ({ modeId: m.modeId, name: m.name })),
      isPrimitive: collection.name.toLowerCase().includes('primitive')
    };
  }

  figma.ui.postMessage({ type: "EXPORT_RESULT", files, collectionsInfo });
}

async function getCollectionsInfo() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionsInfo = {};

  for (const collection of collections) {
    collectionsInfo[collection.name] = {
      modes: collection.modes.map(m => ({ modeId: m.modeId, name: m.name })),
      isPrimitive: collection.name.toLowerCase().includes('primitive')
    };
  }

  figma.ui.postMessage({ type: "COLLECTIONS_INFO", collectionsInfo });
}

function pxToRem(pxValue) {
  const px = parseFloat(pxValue);
  const rem = px / 16;
  return `${rem}rem`;
}

function isFontSizeVariable(pathParts) {
  return pathParts.some(part =>
      part.toLowerCase().includes('fontsize') ||
      (part.toLowerCase().includes('font') && part.toLowerCase().includes('size'))
  );
}

function filterModesByOptions(modes, modeSelection, collectionName) {
  const isPrimitiveCollection = collectionName.toLowerCase().includes('primitive');

  if (isPrimitiveCollection) {
    if (modeSelection === 'all') {
      return modes;
    }

    // Chercher le mode par son modeId
    const selectedMode = modes.find(m => m.modeId === modeSelection);
    return selectedMode ? [selectedMode] : [modes[0]];
  } else {
    // Pour les autres collections (Semantic, etc.), utiliser colorMode
    if (modeSelection === 'all') {
      return modes;
    }

    if (modeSelection === 'light') {
      const lightMode = modes.find(m => m.name.toLowerCase() === 'light');
      return lightMode ? [lightMode] : [modes[0]];
    }

    if (modeSelection === 'dark') {
      const darkMode = modes.find(m => m.name.toLowerCase() === 'dark');
      return darkMode ? [darkMode] : [modes[0]];
    }
  }

  return modes;
}

async function processCollectionCustom({ name, modes, variableIds }, options = {}) {
  const { primitiveMode = 'first', colorMode = 'all', excludeString = false, collectionAliases = {}, opacityFormat = 'rgba' } = options;

  // Utiliser primitiveMode pour les primitives, colorMode pour les autres
  const isPrimitiveCollection = name.toLowerCase().includes('primitive');
  const modeSelection = isPrimitiveCollection ? primitiveMode : colorMode;

  const filteredModes = filterModesByOptions(modes, modeSelection, name);

  const file = {
    fileName: `${toCamelCase(name)}.ts`,
    body: {},
    modes: filteredModes.map(m => ({ modeId: m.modeId, name: m.name })),
    collectionName: name
  };

  const variablesByMode = {};

  for (const mode of filteredModes) {
    variablesByMode[mode.modeId] = {};

    for (const variableId of variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(variableId);
      const { name: varName, resolvedType, valuesByMode } = variable;
      const value = valuesByMode[mode.modeId];

      const allowedTypes = excludeString
          ? ["COLOR", "FLOAT"]
          : ["COLOR", "FLOAT", "STRING"];

      if (value !== undefined && allowedTypes.includes(resolvedType)) {
        const pathParts = varName.split("/").map(part => toCamelCase(part));
        let obj = variablesByMode[mode.modeId];

        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!obj[part]) {
            obj[part] = {};
          }
          obj = obj[part];
        }

        const lastKey = pathParts[pathParts.length - 1];

        if (value.type === "VARIABLE_ALIAS") {
          const referencedVar = await figma.variables.getVariableByIdAsync(value.id);

          const referencedCollection = await figma.variables.getVariableCollectionByIdAsync(
              referencedVar.variableCollectionId
          );

          let collectionName = collectionAliases[referencedCollection.name] || toCamelCase(referencedCollection.name);

          const aliasPath = referencedVar.name.split("/").map(part => toCamelCase(part)).join(".");
          obj[lastKey] = `{${collectionName}.${aliasPath}}`;
        } else {
          if (resolvedType === "COLOR") {
            obj[lastKey] = rgbToHex(value, opacityFormat); // Passer l'option ici
          } else if (resolvedType === "FLOAT") {
            obj[lastKey] = formatNumberValue(value, varName, pathParts);
          } else {
            obj[lastKey] = value;
          }
        }
      }
    }
  }

  if (filteredModes.length > 1) {
    const structuredBody = organizeByTopLevelGroups(variablesByMode, filteredModes);
    file.body = structuredBody;
  } else {
    file.body = variablesByMode[filteredModes[0].modeId];
  }

  return file;
}

function organizeByTopLevelGroups(variablesByMode, modes) {
  const result = {};
  const allTopLevelKeys = new Set();

  Object.values(variablesByMode).forEach(modeData => {
    Object.keys(modeData).forEach(key => allTopLevelKeys.add(key));
  });

  allTopLevelKeys.forEach(topLevelKey => {
    result[topLevelKey] = {};

    modes.forEach(mode => {
      const modeName = `mode${mode.name.charAt(0).toUpperCase() + mode.name.slice(1).toLowerCase()}`;
      const modeData = variablesByMode[mode.modeId];

      if (modeData && modeData[topLevelKey]) {
        result[topLevelKey][modeName] = modeData[topLevelKey];
      }
    });
  });

  return result;
}

function formatNumberValue(value, varName, pathParts) {
  const varLower = varName.toLowerCase();

  if (isFontSizeVariable(pathParts)) {
    if (typeof value === 'number') {
      return pxToRem(value);
    }
    if (typeof value === 'string' && value.includes('px')) {
      return pxToRem(value);
    }
  }

  const needsPixels = varLower.includes('spacing') ||
      varLower.includes('size') ||
      varLower.includes('width') ||
      varLower.includes('radius') ||
      varLower.includes('stroke') ||
      varLower.includes('units') ||
      varLower.includes('gutter') ||
      varLower.includes('shadow') ||
      varLower.includes('metric');

  if (needsPixels && !String(value).includes('px') && !String(value).includes('rem') && !String(value).includes('ms')) {
    if (String(value) === '999' || String(value) === '9999') {
      return `${value}px`;
    }
    return `${value}px`;
  }

  if (String(value).includes('ms')) {
    return value;
  }

  return value;
}

async function processCollection({ name, modes, variableIds }) {
  const files = [];
  for (const mode of modes) {
    const file = { fileName: `${name}.${mode.name}.tokens.json`, body: {} };
    for (const variableId of variableIds) {
      const { name, resolvedType, valuesByMode } =
          await figma.variables.getVariableByIdAsync(variableId);
      const value = valuesByMode[mode.modeId];
      if (value !== undefined && ["COLOR", "FLOAT"].includes(resolvedType)) {
        let obj = file.body;
        name.split("/").forEach((groupName) => {
          obj[groupName] = obj[groupName] || {};
          obj = obj[groupName];
        });
        obj.$type = resolvedType === "COLOR" ? "color" : "number";
        if (value.type === "VARIABLE_ALIAS") {
          const currentVar = await figma.variables.getVariableByIdAsync(
              value.id
          );
          obj.$value = `{${currentVar.name.replace(/\//g, ".")}}`;
        } else {
          obj.$value = resolvedType === "COLOR" ? rgbToHex(value) : value;
        }
      }
    }
    files.push(file);
  }
  return files;
}

figma.ui.onmessage = async (e) => {
  console.log("code received message", e);
  if (e.type === "IMPORT") {
    const { fileName, body } = e;
    importJSONFile({ fileName, body });
  } else if (e.type === "EXPORT") {
    await exportToJSON(e.options || {});
  } else if (e.type === "GET_COLLECTIONS_INFO") {
    await getCollectionsInfo();
  }
};

if (figma.command === "import") {
  figma.showUI(__uiFiles__["import"], {
    width: 1380,
    height: 800,
    themeColors: true
  });
} else if (figma.command === "export") {
  figma.showUI(__uiFiles__["export"], {
    width: 1380,
    height: 800,
    themeColors: true
  });
  // Nouveau : charger les infos des collections dès l'ouverture
  getCollectionsInfo();
}

function rgbToHex({ r, g, b, a }, opacityFormat = 'rgba') {
  if (a !== 1) {
    if (opacityFormat === 'hex') {
      // Format hexadécimal avec opacité
      const toHex = (value) => {
        const hex = Math.round(value * 255).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      };

      const alphaHex = Math.round(a * 255).toString(16).padStart(2, '0');
      const hex = [toHex(r), toHex(g), toHex(b)].join("");
      return `#${hex}${alphaHex}`;
    } else {
      // Format RGBA nettoyé (sans zéros inutiles)
      const cleanAlpha = parseFloat(a.toFixed(4));
      return `rgba(${[r, g, b].map((n) => Math.round(n * 255)).join(", ")}, ${cleanAlpha})`;
    }
  }

  const toHex = (value) => {
    const hex = Math.round(value * 255).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };

  const hex = [toHex(r), toHex(g), toHex(b)].join("");
  return `#${hex}`;
}

function parseColor(color) {
  color = color.trim();
  const rgbRegex = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
  const rgbaRegex =
      /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)$/;
  const hslRegex = /^hsl\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*\)$/;
  const hslaRegex =
      /^hsla\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*,\s*([\d.]+)\s*\)$/;
  const hexRegex = /^#([A-Fa-f0-9]{3}){1,2}$/;
  const floatRgbRegex =
      /^\{\s*r:\s*[\d\.]+,\s*g:\s*[\d\.]+,\s*b:\s*[\d\.]+(,\s*opacity:\s*[\d\.]+)?\s*\}$/;

  if (rgbRegex.test(color)) {
    const [, r, g, b] = color.match(rgbRegex);
    return { r: parseInt(r) / 255, g: parseInt(g) / 255, b: parseInt(b) / 255 };
  } else if (rgbaRegex.test(color)) {
    const [, r, g, b, a] = color.match(rgbaRegex);
    return {
      r: parseInt(r) / 255,
      g: parseInt(g) / 255,
      b: parseInt(b) / 255,
      a: parseFloat(a),
    };
  } else if (hslRegex.test(color)) {
    const [, h, s, l] = color.match(hslRegex);
    return hslToRgbFloat(parseInt(h), parseInt(s) / 100, parseInt(l) / 100);
  } else if (hslaRegex.test(color)) {
    const [, h, s, l, a] = color.match(hslaRegex);
    return Object.assign(
        hslToRgbFloat(parseInt(h), parseInt(s) / 100, parseInt(l) / 100),
        { a: parseFloat(a) }
    );
  } else if (hexRegex.test(color)) {
    const hexValue = color.substring(1);
    const expandedHex =
        hexValue.length === 3
            ? hexValue
                .split("")
                .map((char) => char + char)
                .join("")
            : hexValue;
    return {
      r: parseInt(expandedHex.slice(0, 2), 16) / 255,
      g: parseInt(expandedHex.slice(2, 4), 16) / 255,
      b: parseInt(expandedHex.slice(4, 6), 16) / 255,
    };
  } else if (floatRgbRegex.test(color)) {
    return JSON.parse(color);
  } else {
    throw new Error("Invalid color format");
  }
}

function hslToRgbFloat(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  if (s === 0) {
    return { r: l, g: l, b: l };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, (h + 1 / 3) % 1);
  const g = hue2rgb(p, q, h % 1);
  const b = hue2rgb(p, q, (h - 1 / 3) % 1);

  return { r, g, b };
}
