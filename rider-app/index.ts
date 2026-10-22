import { registerRootComponent } from 'expo';

import App from './App';
import { withUpdateGate } from './src/components/UpdateGate';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
// The update gate asks the API which app versions it still supports before the app opens (see UpdateGate).
registerRootComponent(withUpdateGate(App));
