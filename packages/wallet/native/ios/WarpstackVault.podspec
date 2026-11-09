# The native vault (sealed core): Swift glue over the Rust core in ../rust, which
# build-ios.sh compiles into WarpstackVaultCore.xcframework with its uniffi bindings.
Pod::Spec.new do |s|
  s.name           = 'WarpstackVault'
  s.version        = '0.0.0'
  s.summary        = 'Warpstack transient vault and app key store'
  s.license        = 'MIT'
  s.author         = 'Warpstack'
  s.homepage       = 'https://github.com/daemons404/warpstack'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '*.swift', 'Generated/*.swift'
  s.vendored_frameworks = 'WarpstackVaultCore.xcframework'
end
