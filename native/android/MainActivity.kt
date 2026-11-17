package com.smartpos.studio

import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        registerPlugin(PosLocalDatabasePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
