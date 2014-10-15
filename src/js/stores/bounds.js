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

define(function (require, exports, module) {
    "use strict";

    var Fluxxor = require("fluxxor"),
        events = require("../events"),
        Bounds = require("../models/bounds");

    var BoundsStore = Fluxxor.createStore({
        initialize: function () {
            this._layerBounds = {};
            this._documentBounds = {};
            this.bindActions(
                events.documents.DOCUMENT_UPDATED, this._resetDocumentLayerBounds,
                events.documents.CURRENT_DOCUMENT_UPDATED, this._updateDocumentLayers,
                events.documents.RESET_DOCUMENTS, this._resetDocumentLayerBounds
            );
        },

        getState: function () {
            return {};
        },

        getDocumentBounds: function (documentID) {
            return this._documentBounds[documentID];
        },

        getLayerBounds: function (documentID, layerID) {
            return this._layerBounds[documentID][layerID];
        },

        _resetDocumentLayerBounds: function (payload) {
            payload.documents.forEach(function (docObj) {
                var rawDocument = docObj.document,
                    documentID = rawDocument.documentID,
                    layerArray = docObj.layers;

                this._layerBounds[documentID] = layerArray.reduce(function (boundsMap, layerObj) {
                    boundsMap[layerObj.layerID] = new Bounds(layerObj);
                    return boundsMap;
                }, {});
            }, this);

            this.emit("change");
        }


    });
    module.exports = BoundsStore;
});
