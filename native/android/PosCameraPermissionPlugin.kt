package com.smartpos.studio

import android.Manifest
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "PosCameraPermission",
    permissions = [Permission(alias = "camera", strings = [Manifest.permission.CAMERA])]
)
class PosCameraPermissionPlugin : Plugin() {
    @PluginMethod
    fun requestCameraPermission(call: PluginCall) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("camera", call, "cameraPermissionResult")
    }

    @PermissionCallback
    private fun cameraPermissionResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("camera") == PermissionState.GRANTED))
    }
}
