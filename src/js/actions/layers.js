/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        Immutable = require("immutable"),
        _ = require("lodash");
        
    var photoshopEvent = require("adapter/lib/photoshopEvent"),
        descriptor = require("adapter/ps/descriptor"),
        documentLib = require("adapter/lib/document"),
        layerLib = require("adapter/lib/layer"),
        OS = require("adapter/os");

    var Layer = require("js/models/layer"),
        documents = require("js/actions/documents"),
        collection = require("js/util/collection"),
        events = require("../events"),
        shortcuts = require("./shortcuts"),
        locks = require("js/locks"),
        process = require("js/util/process"),
        locking = require("js/util/locking"),
        strings = require("i18n!nls/strings");

    var _paintOptions = {
        immediateUpdate: true,
        quality: "draft"
    };

    /**
     * @private
     * @type {Array.<string>} Properties to be included when requesting layer
     * descriptors from Photoshop.
     */
    var _layerProperties = [
        "layerID",
        "name",
        "visible",
        "layerLocking",
        "itemIndex",
        "background",
        "boundsNoEffects",
        "opacity",
        "layerFXVisible",
        "mode"
    ];

    /**
     * @private
     * @type {Array.<string>} Properties to be included if present when requesting
     * layer descriptors from Photoshop.
     */
    var _optionalLayerProperties = [
        "adjustment",
        "AGMStrokeStyleInfo",
        "textKey",
        "layerKind",
        "keyOriginType",
        "fillEnabled",
        "fillOpacity",
        "layerEffects"
    ];

    /**
     * Get layer descriptors for the given layer references. Only the
     * properties listed in the arrays above will be included for performance
     * reasons. NOTE: All layer references must reference the same document.
     * 
     * @private
     * @param {Immutable.Iterable.<object>} references
     * @return {Promise.<Array.<object>>}
     */
    var _getLayersByRef = function (references) {
        var refObjs = references.reduce(function (refs, reference) {
            return refs.concat(_layerProperties.map(function (property) {
                return {
                    reference: reference,
                    property: property
                };
            }));
        }, []);

        var layerPropertiesPromise = descriptor.batchGetProperties(refObjs)
            .reduce(function (results, value, index) {
                var propertyIndex = index % _layerProperties.length;

                if (propertyIndex === 0) {
                    results.push({});
                }

                var result = results[results.length - 1],
                    property = _layerProperties[propertyIndex];

                result[property] = value;
                return results;
            }, []);

        var refObjsOptional = references.reduce(function (refs, reference) {
            return refs.concat(_optionalLayerProperties.map(function (property) {
                return {
                    reference: reference,
                    property: property
                };
            }));
        }, []);

        var optionalPropertiesPromise = descriptor.batchGetProperties(refObjsOptional, { continueOnError: true })
            .then(function (response) {
                var allResults = response[0];

                return allResults.reduce(function (results, value, index) {
                    var propertyIndex = index % _optionalLayerProperties.length;

                    if (propertyIndex === 0) {
                        results.push({});
                    }

                    var result = results[results.length - 1],
                        property = _optionalLayerProperties[propertyIndex];

                    if (value && value.hasOwnProperty(property)) {
                        result[property] = value[property];
                    }
                    
                    return results;
                }, []);
            });

        return Promise.join(layerPropertiesPromise, optionalPropertiesPromise,
            function (allProperties, allOptionalProperties) {
                return allProperties.map(function (properties, index) {
                    var optionalProperties = allOptionalProperties[index];
                    return _.assign(properties, optionalProperties);
                });
            });
    };

    /**
     * Emit RESET_LAYER with layer descriptors for all given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     */
    var resetLayersCommand = function (document, layers) {
        var layerRefs = layers.map(function (layer) {
            return [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ];
        }).toArray();

        return _getLayersByRef(layerRefs)
            .bind(this)
            .then(function (descriptors) {
                var index = 0, // annoyingly, Immutable.Set.prototype.forEach does not provide an index
                    payload = {
                        documentID: document.id
                    };

                payload.layers = layers.map(function (layer) {
                    return {
                        layerID: layer.id,
                        descriptor: descriptors[index++]
                    };
                });

                this.dispatch(events.document.RESET_LAYERS, payload);
            });
    };

    /**
     * Selects the given layer with given modifiers
     *
     * @param {Document} document Owner document
     * @param {Layer|Immutable.Iterable.<Layer>} layerSpec Either a single layer that
     *  the selection is based on, or an array of such layers
     * @param {string} modifier Way of modifying the selection. Possible values
     *  are defined in `adapter/lib/layer.js` under `select.vals`
     *
     * @returns {Promise}
     */
    var selectLayerCommand = function (document, layerSpec, modifier) {
        if (layerSpec instanceof Layer) {
            layerSpec = Immutable.List.of(layerSpec);
        }

        var payload = {
            documentID: document.id
        };

        // TODO: Dispatch optimistically here for the other modifiers, and
        // eventually remove SELECT_LAYERS_BY_INDEX.
        if (!modifier || modifier === "select") {
            payload.selectedIDs = collection.pluck(layerSpec, "id");
            process.nextTick(function () {
                this.dispatch(events.document.SELECT_LAYERS_BY_ID, payload);
            }, this);
        }

        var layerRef = layerSpec
            .map(function (layer) {
                return layerLib.referenceBy.id(layer.id);
            })
            .unshift(documentLib.referenceBy.id(document.id))
            .toArray();

        var selectObj = layerLib.select(layerRef, false, modifier);
        return descriptor.playObject(selectObj)
            .bind(this)
            .then(function () {
                if (modifier && modifier !== "select") {
                    descriptor.getProperty(documentLib.referenceBy.id(document.id), "targetLayers")
                        .bind(this)
                        .then(function (targetLayers) {
                            payload.selectedIndices = _.pluck(targetLayers, "index");
                            this.dispatch(events.document.SELECT_LAYERS_BY_INDEX, payload);
                        });
                }
            });
    };

    /**
     * Renames the given layer
     *
     * @param {Document} document Owner document
     * @param {Layer} layer Layer to be renamed
     * @param {string} newName What to rename the layer
     * 
     * @returns {Promise}
     */
    var renameLayerCommand = function (document, layer, newName) {
        var payload = {
            documentID: document.id,
            layerID: layer.id,
            name: newName
        };

        process.nextTick(function () {
            this.dispatch(events.document.RENAME_LAYER, payload);
        }, this);

        var layerRef = [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ],
            renameObj = layerLib.rename(layerRef, newName);

        return descriptor.playObject(renameObj);
    };

    /**
     * Deselects all layers in the given document, or in the current document if none is provided.
     * 
     * @param {document=} document
     * @returns {Promise}
     */
    var deselectAllLayersCommand = function (document) {
        if (document === undefined) {
            document = this.flux.store("application").getCurrentDocument();
        }

        // If document doesn't exist, or is a flat document
        if (!document || document.layers.all.isEmpty()) {
            return Promise.resolve();
        }

        var payload = {
            documentID: document.id,
            selectedIDs: []
        };

        process.nextTick(function () {
            this.dispatch(events.document.SELECT_LAYERS_BY_ID, payload);
        }, this);

        // FIXME: The descriptor below should be specific to the document ID
        return descriptor.playObject(layerLib.deselectAll());
    };

    /**
     * Selects all layers in the given document, or in the current document if none is provided.
     * 
     * @param {document=} document
     * @returns {Promise}
     */
    var selectAllLayersCommand = function (document) {
        if (document === undefined) {
            document = this.flux.store("application").getCurrentDocument();
        }

        // If document doesn't exist, or is a flat document
        if (!document || document.layers.all.isEmpty()) {
            return Promise.resolve();
        }

        return this.transfer(selectLayer, document, document.layers.all);
    };

    /**
     * Deletes the selected layers in the given document, or in the current document if none is provided
     *
     * @param {?document} document
     * @return {Promise}
     */
    var deleteSelectedLayersCommand = function (document) {
        if (document === undefined) {
            document = this.flux.store("application").getCurrentDocument();
        }
        
        // If there is no doc, a flat doc, or all layers are going to be deleted, cancel
        if (!document || document.layers.all.isEmpty() ||
            !document.layers.selectedLayersDeletable) {
            return Promise.resolve();
        }

        var documentID = document.id,
            layers = document.layers.allSelected,
            layerIDs = collection.pluck(layers, "id"),
            deletePlayObject = layerLib.delete(layerLib.referenceBy.current),
            payload = {
                documentID: documentID,
                layerIDs: layerIDs
            },
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.DELETE_LAYERS,
                    target: documentLib.referenceBy.id(documentID)
                }
            };

        process.nextTick(function () {
            this.dispatch(events.document.DELETE_SELECTED, payload);
        }, this);

        return locking.playWithLockOverride(document, layers, deletePlayObject, options, true);
    };

    /**
     * Groups the currently active layers
     * 
     * @param {Document} document 
     * @return {Promise}
     */
    var groupSelectedLayersCommand = function (document) {
        
        // plugin hangs on call with no selection, so for now, we avoid calling it
        if (document.layers.selected.size === 0) {
            return Promise.resolve();
        }

        return descriptor.playObject(layerLib.groupSelected())
            .bind(this)
            .then(function (groupResult) {
                var payload = {
                    documentID: document.id,
                    groupID: groupResult.layerSectionStart,
                    groupEndID: groupResult.layerSectionEnd,
                    groupname: groupResult.name
                };

                this.dispatch(events.document.GROUP_SELECTED, payload);
            });
    };

    /**
     * Groups the selected layers in the currently active document
     * 
     * @return {Promise}
     */
    var groupSelectedLayersInCurrentDocumentCommand = function () {
        var flux = this.flux,
            applicationStore = flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument();

        if (!currentDocument) {
            return Promise.resolve();
        }

        return this.transfer(groupSelected, currentDocument);
    };

    /**
     * Changes the visibility of layer
     *
     * @param {Document} document
     * @param {Layer} layer
     * @param {boolean} visible Whether to show or hide the layer

     * @returns {Promise}
     */
    var setVisibilityCommand = function (document, layer, visible) {
        var payload = {
                documentID: document.id,
                layerID: layer.id,
                visible: visible
            },
            command = visible ? layerLib.show : layerLib.hide,
            layerRef = [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ];

        process.nextTick(function () {
            this.dispatch(events.document.VISIBILITY_CHANGED, payload);
        }, this);

        return descriptor.playObject(command.apply(this, [layerRef]));
    };

    /**
     * Unlocks the background layer of the document
     * FIXME: Does not care about the document reference
     * FIXME: Updates the whole document, because unlocking background 
     * layer creates a whole new layer with new ID and a name
     *
     * @param {Document} document
     * @param {Layer} layer
     *
     * @returns {Promise}
     */
    var _unlockBackgroundLayer = function (document, layer) {
        return descriptor.playObject(layerLib.unlockBackground(layer.id))
            .bind(this)
            .then(function () {
                return this.transfer(documents.updateDocument, document.id);
            });
    };

    /**
     * Changes the lock state of layer
     *
     * @param {Document} document
     * @param {Layer} layer
     * @param {boolean} locked Whether all properties of layer is to be locked
     *
     * @returns {Promise}
     */
    var setLockingCommand = function (document, layer, locked) {
        var payload = {
                documentID: document.id,
                layerID: layer.id,
                locked: locked
            },
            layerRef = [
                documentLib.referenceBy.id(document.id),
                layerLib.referenceBy.id(layer.id)
            ];

        process.nextTick(function () {
            this.dispatch(events.document.LOCK_CHANGED, payload);
        }, this);

        if (layer.isBackground) {
            return _unlockBackgroundLayer.call(this, document, layer);
        } else {
            return descriptor.playObject(layerLib.setLocking(layerRef, locked));
        }
    };

    /**
     * Set the opacity of the given layers.
     * 
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {number} opacity Opacity as a percentage
     * @return {Promise}
     */
    var setOpacityCommand = function (document, layers, opacity) {
        var payload = {
                documentID: document.id,
                layerIDs: collection.pluck(layers, "id"),
                opacity: opacity
            },
            playObjects = layers.map(function (layer) {
                var layerRef = [
                    documentLib.referenceBy.id(document.id),
                    layerLib.referenceBy.id(layer.id)
                ];

                return layerLib.setOpacity(layerRef, opacity);
            }),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.CHANGE_LAYER_OPACITY,
                    target: documentLib.referenceBy.id(document.id)
                },
                paintOptions: _paintOptions
            };

        process.nextTick(function () {
            this.dispatch(events.document.OPACITY_CHANGED, payload);
        }, this);

        return locking.playWithLockOverride(document, layers, playObjects.toArray(), options);
    };

    /**
     * Set the lock status of the selected layers in the current document as
     * specified.
     * 
     * @param {boolean} locked Whether to lock or unlock the selected layers
     * @return {Promise}
     */
    var _setLockingInCurrentDocument = function (locked) {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument();

        if (!currentDocument) {
            return Promise.resolve();
        }

        var lockPromises = currentDocument.layers.selected.map(function (layer) {
            return this.transfer(setLocking, currentDocument, layer, locked);
        }, this).toArray();

        return Promise.all(lockPromises);
    };

    /**
     * Lock the selected layers in the current document.
     * 
     * @return {Promise}
     */
    var lockSelectedInCurrentDocumentCommand = function () {
        return _setLockingInCurrentDocument.call(this, true);
    };

    /**
     * Unlock the selected layers in the current document.
     * 
     * @return {Promise}
     */
    var unlockSelectedInCurrentDocumentCommand = function () {
        return _setLockingInCurrentDocument.call(this, false);
    };

    var _getLayerIDsForDocument = function (doc) {
        var layerCount = doc.numberOfLayers,
            startIndex = (doc.hasBackgroundLayer ? 0 : 1),
            layerRefs = _.range(layerCount, startIndex - 1, -1).map(function (i) {
                return [
                    documentLib.referenceBy.id(doc.documentID),
                    layerLib.referenceBy.index(i)
                ];
            });
        
        return descriptor.batchGetProperty(layerRefs, "layerID");
    };

    /**
     * Moves the given layers to their given position
     * In Photoshop images, targetIndex 0 means bottom of the document, and will throw if
     * it is a background layer, targetIndex n, where n is the number of layers, means top of the 
     * document. Hidden endGroup layers also count in the index, and are used to tell between whether
     * to put next to the group, or inside the group as last element
     *
     * @param {number} documentID Owner document ID
     * @param {number|Immutable.Iterable.<number>} layerSpec Either an ID of single layer that
     *  the selection is based on, or an array of such layer IDs
     * @param {number} targetIndex Target index where to drop the layers
     *
     * @return {Promise} Resolves to the new ordered IDs of layers, or rejects if targetIndex
     * is invalid, as example when it is a child of one of the layers in layer spec
     **/
    var reorderLayersCommand = function (documentID, layerSpec, targetIndex) {
        if (!Immutable.Iterable.isIterable(layerSpec)) {
            layerSpec = Immutable.List.of(layerSpec);
        }
        
        var documentRef = documentLib.referenceBy.id(documentID),
            layerRef = layerSpec
                .map(function (layerID) {
                    return layerLib.referenceBy.id(layerID);
                })
                .unshift(documentRef)
                .toArray();

        var targetRef = layerLib.referenceBy.index(targetIndex),
            reorderObj = layerLib.reorder(layerRef, targetRef);

        return descriptor.playObject(reorderObj)
            .bind(this)
            .then(function () {
                return descriptor.get(documentRef)
                    .bind(this)
                    .then(function (doc) {
                        return _getLayerIDsForDocument(doc)
                            .then(function (layerIDs) {
                                var payload = {
                                    documentID: documentID,
                                    layerIDs: layerIDs
                                };

                                this.dispatch(events.document.REORDER_LAYERS, payload);
                            }.bind(this));
                    });
            });
    };

    /**
     * Set the blend mode of the given layers.
     *
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {string} mode Blend mode ID
     * @return {Promise}
     */
    var setBlendModeCommand = function (document, layers, mode) {
        var documentRef = documentLib.referenceBy.id(document.id),
            layerIDs = collection.pluck(layers, "id"),
            layerRef = layerIDs
                .map(function (layerID) {
                    return layerLib.referenceBy.id(layerID);
                })
                .unshift(documentRef)
                .toArray(),
            options = {
                historyStateInfo: {
                    name: strings.ACTIONS.SET_BLEND_MODE,
                    target: documentLib.referenceBy.id(document.id)
                }
            };

        process.nextTick(function () {
            var payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                mode: mode
            };

            this.dispatch(events.document.BLEND_MODE_CHANGED, payload);
        }, this);

        return locking.playWithLockOverride(document, layers,
            layerLib.setBlendMode(layerRef, mode), options);
    };

    /**
     * Listen for Photohop layer layer events.
     *
     * @return {Promise}
     */
    var beforeStartupCommand = function () {
        descriptor.addListener("delete", function (event) {
            var target = photoshopEvent.targetOf(event);

            if (target === "layer") {
                this.flux.actions.documents.updateCurrentDocument();
            }
        }.bind(this));

        var deleteFn = function () {
            this.flux.actions.layers.deleteSelected();
        }.bind(this);

        var backspacePromise = this.transfer(shortcuts.addShortcut, OS.eventKeyCode.BACKSPACE, {}, deleteFn),
            deletePromise = this.transfer(shortcuts.addShortcut, OS.eventKeyCode.DELETE, {}, deleteFn);

        return Promise.join(backspacePromise, deletePromise);
    };

    var selectLayer = {
        command: selectLayerCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var rename = {
        command: renameLayerCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var selectAll = {
        command: selectAllLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var deselectAll = {
        command: deselectAllLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var deleteSelected = {
        command: deleteSelectedLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var groupSelected = {
        command: groupSelectedLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var groupSelectedInCurrentDocument = {
        command: groupSelectedLayersInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setVisibility = {
        command: setVisibilityCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setLocking = {
        command: setLockingCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setOpacity = {
        command: setOpacityCommand,
        reads: [],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var lockSelectedInCurrentDocument = {
        command: lockSelectedInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var unlockSelectedInCurrentDocument = {
        command: unlockSelectedInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var reorderLayers = {
        command: reorderLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var setBlendMode = {
        command: setBlendModeCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    var resetLayers = {
        command: resetLayersCommand,
        reads: [locks.PS_DOC],
        writes: [locks.JS_DOC]
    };

    var beforeStartup = {
        command: beforeStartupCommand,
        reads: [locks.PS_DOC, locks.PS_APP],
        writes: [locks.JS_DOC, locks.JS_SHORTCUT, locks.JS_POLICY, locks.PS_APP]
    };

    exports.select = selectLayer;
    exports.rename = rename;
    exports.selectAll = selectAll;
    exports.deselectAll = deselectAll;
    exports.deleteSelected = deleteSelected;
    exports.groupSelected = groupSelected;
    exports.groupSelectedInCurrentDocument = groupSelectedInCurrentDocument;
    exports.setVisibility = setVisibility;
    exports.setLocking = setLocking;
    exports.setOpacity = setOpacity;
    exports.lockSelectedInCurrentDocument = lockSelectedInCurrentDocument;
    exports.unlockSelectedInCurrentDocument = unlockSelectedInCurrentDocument;
    exports.reorder = reorderLayers;
    exports.setBlendMode = setBlendMode;
    exports.resetLayers = resetLayers;
    exports.beforeStartup = beforeStartup;

    exports._getLayersByRef = _getLayersByRef;
});
